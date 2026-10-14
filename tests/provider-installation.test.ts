import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
	getProviderInstallationStatus,
	getProviderInstallationRun,
	resolvePluginVersion,
	compareSemver,
} from "../src/host/installation-manager.ts";
import { handleDiscoveryRequest } from "../src/host/discovery-handler.ts";
import type { ModelCatalog } from "../src/host/catalog.ts";

const providerInstallationActionKindSchema = z.enum(["install", "update"]);
const providerInstallationActionSchema = z.object({
	kind: providerInstallationActionKindSchema,
	label: z.enum(["Install", "Update"]),
	command: z.string().min(1),
}).passthrough();

const providerInstallationSourceSchema = z.enum(["notInstalled", "npmGlobal", "external"]);

const providerInstallationStatusSchema = z.object({
	executableName: z.string().min(1),
	executablePath: z.string().min(1).nullable(),
	installed: z.boolean(),
	installSource: providerInstallationSourceSchema,
	currentVersion: z.string().min(1).nullable(),
	latestVersion: z.string().min(1).nullable(),
	minimumSupportedVersion: z.string().min(1).nullable(),
	npmPackageName: z.string().min(1).nullable(),
	npmGlobalPackageVersion: z.string().min(1).nullable(),
	installAction: providerInstallationActionSchema.nullable(),
	needsUpdate: z.boolean(),
	versionUnsupported: z.boolean(),
}).passthrough();

const providerInstallationCommandSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).max(64),
	displayCommand: z.string().min(1),
}).passthrough();

const providerInstallationVerificationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("installed") }).passthrough(),
	z.object({
		kind: z.literal("version_changed"),
		previousVersion: z.string().min(1),
	}).passthrough(),
	z.object({
		kind: z.literal("version_at_least"),
		version: z.string().min(1),
	}).passthrough(),
]);

const providerInstallationRunResultSchema = z.discriminatedUnion("available", [
	z.object({
		available: z.literal(false),
		message: z.string().min(1),
	}).passthrough(),
	z.object({
		available: z.literal(true),
		command: providerInstallationCommandSchema,
		verification: providerInstallationVerificationSchema,
	}).passthrough(),
]);

const mockCatalog: ModelCatalog = {
	listModels: async () => [],
	getHealth: async () => ({ status: "ready" as const, canInstall: true, canUpdate: true, loginCommand: "pi" }),
	start: async () => {},
	stop: async () => {},
	getModels: () => [],
};

describe("Native Provider Installation Lifecycle (Cycle 76)", () => {
	it("resolves the dynamic plugin version 0.2.29 without hardcoded fallbacks", () => {
		const version = resolvePluginVersion();
		assert.equal(version, "0.2.29");
	});

	it("correctly compares semver strings", () => {
		assert.equal(compareSemver("0.2.29", "0.2.0") > 0, true);
		assert.equal(compareSemver("0.2.29", "0.2.29"), 0);
		assert.equal(compareSemver("0.1.0", "0.2.0") < 0, true);
	});

	it("provider/installation/status conforms strictly to BB wire schema (checkUpdates: false)", async () => {
		const status = await getProviderInstallationStatus({ checkUpdates: false });
		const parsed = providerInstallationStatusSchema.safeParse(status);

		assert.equal(parsed.success, true);
		assert.equal(status.installed, true);
		assert.equal(status.installSource, "external");
		assert.equal(status.currentVersion, "0.2.29");
		assert.equal(status.npmPackageName, "bb-plugin-provider-pi-durable");
		assert.equal(status.minimumSupportedVersion, "0.2.0");
		assert.equal(status.needsUpdate, false);
		assert.equal(status.versionUnsupported, false);
		assert.notEqual(status.installAction, null);
		assert.equal(status.installAction?.kind, "update");
		assert.equal(status.installAction?.command, "bb plugin update provider-pi-durable");
	});

	it("provider/installation/run returns valid discriminated union for update action", async () => {
		const runResult = await getProviderInstallationRun("update");
		const parsed = providerInstallationRunResultSchema.safeParse(runResult);

		assert.equal(parsed.success, true);
		assert.equal(runResult.available, true);
		if (runResult.available) {
			assert.equal(runResult.command.command, "bb");
			assert.deepEqual(runResult.command.args, ["plugin", "update", "provider-pi-durable"]);
			assert.equal(runResult.command.displayCommand, "bb plugin update provider-pi-durable");
			assert.equal(runResult.verification.kind, "version_changed");
			if (runResult.verification.kind === "version_changed") {
				assert.equal(runResult.verification.previousVersion, "0.2.29");
			}
		}
	});

	it("discovery-handler routes provider/installation/status and provider/installation/run via typed params", async () => {
		const statusRes = await handleDiscoveryRequest("provider/installation/status", { checkUpdates: false }, mockCatalog);
		assert.notEqual(statusRes, null);
		assert.equal(providerInstallationStatusSchema.safeParse(statusRes).success, true);

		const runRes = await handleDiscoveryRequest("provider/installation/run", { action: "update" }, mockCatalog);
		assert.notEqual(runRes, null);
		assert.equal(providerInstallationRunResultSchema.safeParse(runRes).success, true);
	});

	it("getProviderInstallationStatus sets needsUpdate: true when remote version is higher", async () => {
		const { resetPluginVersionCacheForTesting } = await import("../src/host/installation-manager.ts");
		resetPluginVersionCacheForTesting();
		const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{ name: "v0.3.0" }]), { status: 200 });
		const status = await getProviderInstallationStatus({ checkUpdates: true, fetchFn: mockFetch });
		assert.equal(status.latestVersion, "0.3.0");
		assert.equal(status.needsUpdate, true);
	});

	it("getProviderInstallationStatus returns currentVersion and needsUpdate: false when remote is older or equal", async () => {
		const { resetPluginVersionCacheForTesting } = await import("../src/host/installation-manager.ts");
		resetPluginVersionCacheForTesting();
		const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{ name: "v0.2.19" }]), { status: 200 });
		const status = await getProviderInstallationStatus({ checkUpdates: true, fetchFn: mockFetch });
		assert.equal(status.latestVersion, "0.2.29");
		assert.equal(status.needsUpdate, false);
	});

	it("getProviderInstallationStatus falls back to currentVersion when offline or remote fails", async () => {
		const { resetPluginVersionCacheForTesting } = await import("../src/host/installation-manager.ts");
		resetPluginVersionCacheForTesting();
		const mockFetch: typeof fetch = async () => { throw new Error("Offline network"); };
		const status = await getProviderInstallationStatus({ checkUpdates: true, fetchFn: mockFetch });
		assert.equal(status.latestVersion, "0.2.29");
		assert.equal(status.needsUpdate, false);
	});
});
