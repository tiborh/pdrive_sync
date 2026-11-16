import { expect, test } from "bun:test";
import {
  APP_VERSION,
  KEYRING_SERVICE,
  validateEnvironment,
} from "../src/identity.ts";
import { getConfig } from "../../.local/proton-sdk/cli/src/config.ts";
import { CREDENTIALS_SERVICE } from "../../.local/proton-sdk/cli/src/credentials/constants.ts";

test("patched reference host uses external authentication and isolated credentials", () => {
  const config = getConfig({
    appVersion: APP_VERSION,
    clientUidPrefix: "test",
  });
  expect(config.authClientId).toBe("external-drive");
  expect(CREDENTIALS_SERVICE).toBe(KEYRING_SERVICE);
  expect(config.appDir).toContain("pdrive_sync-integration");
});
test("rejects proxy endpoints, shared state and plaintext credentials", () => {
  for (const environment of [
    { PROTON_DRIVE_BASE_URL: "example.com" },
    { PROTON_DRIVE_CACHE_DIR: "/tmp/shared" },
    { PROTON_DRIVE_CREDENTIALS_STORE: "unsafe_file" },
    { PROTON_DRIVE_UNSAFE_CACHE: "true" },
  ]) {
    expect(() => validateEnvironment(environment)).toThrow();
  }
  expect(() => validateEnvironment({})).not.toThrow();
});
