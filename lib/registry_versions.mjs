// Recovery-only runtimes must refuse the graph registry so they cannot start a reserved task.
export const RECOVERY_REGISTRY_VERSION = 3;
export const PLAN_REGISTRY_VERSION = 4;
export const DISPATCH_REGISTRY_VERSION = 5;
export const PLAN_CONTROL_REGISTRY_VERSION = 6;
export const PLAN_STORE_VERSION = 2;

export const matchesPlanFormat = (manifest, minimum = PLAN_REGISTRY_VERSION) => {
  const version = manifest?.registryVersion;
  return version >= minimum && (version === PLAN_CONTROL_REGISTRY_VERSION ? manifest.dependencyPlanVersion === PLAN_STORE_VERSION
    : [PLAN_REGISTRY_VERSION, DISPATCH_REGISTRY_VERSION].includes(version) && manifest.dependencyPlanVersion === 1);
};
