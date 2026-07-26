// SPDX-License-Identifier: MIT

/** Consumer-neutral launchd identity for the bundled Manager service. */
export const DEFAULT_MANAGER_LAUNCHD_LABEL = 'app.idacc.manager';

export function managerLaunchdLabel(value = process.env.MANAGER_LAUNCHD_LABEL): string {
  const configured = String(value ?? '').trim();
  return configured || DEFAULT_MANAGER_LAUNCHD_LABEL;
}

export function managerHealthAttestation(
  env: {
    IDACC_SERVICE_ID?: string;
    IDACC_RUNTIME_VERSION?: string;
    IDACC_INSTANCE_NONCE?: string;
  } = process.env,
): Record<string, string> {
  const service = String(env.IDACC_SERVICE_ID ?? '').trim();
  const runtimeVersion = String(env.IDACC_RUNTIME_VERSION ?? '').trim();
  const instanceNonce = String(env.IDACC_INSTANCE_NONCE ?? '').trim();
  return {
    ...(service ? { service } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
    ...(instanceNonce ? { instanceNonce } : {}),
    protocolVersion: 'idacc.health.v1',
  };
}
