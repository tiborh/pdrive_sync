export const UPSTREAM_REVISION = "8a44654aece1609f0f7218be51c205103945abd8";
export const APP_VERSION = "external-drive-pdrive_sync@0.1.0-alpha";
export const SDK_VERSION = "js@0.23.0+8a44654";
export const KEYRING_SERVICE = "pdrive_sync/integration-session";

export function validateEnvironment(
  environment: Record<string, string | undefined>,
): void {
  if (
    environment.PROTON_DRIVE_BASE_URL &&
    environment.PROTON_DRIVE_BASE_URL !== "drive-api.proton.me"
  ) {
    throw new Error(
      "Only the official drive-api.proton.me endpoint is allowed.",
    );
  }
  if (environment.PROTON_DRIVE_CACHE_DIR) {
    throw new Error(
      "PROTON_DRIVE_CACHE_DIR must be unset: the helper uses its own XDG directories.",
    );
  }
  if (
    environment.PROTON_DRIVE_CREDENTIALS_STORE &&
    environment.PROTON_DRIVE_CREDENTIALS_STORE !== "keychain"
  ) {
    throw new Error("The integration helper requires the OS keychain.");
  }
  if (
    environment.PROTON_DRIVE_UNSAFE_CACHE &&
    !["false", "0", "no"].includes(environment.PROTON_DRIVE_UNSAFE_CACHE)
  ) {
    throw new Error("Unencrypted crypto caches are not allowed.");
  }
}
