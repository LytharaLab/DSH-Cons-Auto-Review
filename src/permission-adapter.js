/** Extend the live host service; no profile row replacement or second service. */
import { registerReviewPreset } from "./preset-defaults.js";
function descriptorOf(service, name) {
  for (let object = service; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor) return descriptor;
  }
}

/**
 * Patch only this service instance for the DCAR effect lifetime. Methods use
 * their calling `this`, so Cordis caller-context proxies and the original
 * service's projection/command closures all see the same registration.
 */
export function attachPermissionAdapter(service) {
  // Compatibility with the 1.0.0 adapter that some existing profiles retain.
  if (typeof service.registerReviewPreset === "function") return () => {};
  const keys = ["names", "specOf", "derive", "apply", "registerReviewPreset"];
  const own = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(service, key)]));
  const names = descriptorOf(service, "names")?.get;
  const original = Object.fromEntries(
    ["specOf", "derive", "apply"].map((key) => [key, descriptorOf(service, key)?.value]),
  );
  if (typeof names !== "function" ||
      Object.values(original).some((method) => typeof method !== "function") ||
      typeof service.emitCatalogChanged !== "function")
    throw new Error("DCAR requires the DSH 0.1.7-rc.2 / 0.2.0-rc.2 permission service runtime APIs");
  if (!Object.isExtensible(service) || [...own.values()].some((d) => d && !d.configurable))
    throw new Error("DCAR cannot extend this permission service instance");
  const entries = new Map();
  const installed = {
    names: { get() { return [...new Set([...names.call(this), ...entries.keys()])]; } },
    specOf: { value: function (name) {
      return entries.get(name)?.spec ?? original.specOf.call(this, name);
    } },
    derive: { value: function (state) {
      const entry = entries.get(state.preset);
      if (entry && state.sandbox === entry.spec.sandbox &&
          (state.approval === entry.spec.approval || state.approval === "never"))
        return state.preset;
      const derived = original.derive.call(this, state);
      return derived === "CAutoR" && entries.has("CAutoR") ? "custom" : derived;
    } },
    apply: { value: function (session, name, setApproval) {
      entries.get(name)?.admit();
      return original.apply.call(this, session, name, setApproval);
    } },
    registerReviewPreset: { value: function (name, spec, admit) {
      return registerReviewPreset(this, entries, name, spec, admit);
    } },
  };
  // Validate before changing anything; rollback an unexpected partial failure.
  const changed = [];
  const restore = () => {
    for (const key of [...changed].reverse()) {
      const prior = own.get(key);
      if (prior) Object.defineProperty(service, key, prior);
      else Reflect.deleteProperty(service, key);
    }
  };
  try {
    for (const key of keys) {
      Object.defineProperty(service, key, { ...installed[key], configurable: true });
      changed.push(key);
    }
  } catch (error) { restore(); throw error; }
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    entries.clear();
    restore();
    service.emitCatalogChanged();
  };
}
