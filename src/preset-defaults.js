/** A persisted CAutoR default must remain confined before DCAR activates. */
export const DORMANT_PRESET = Object.freeze({
  sandbox: "read-only",
  approval: "never",
  name: "CAutoR（DCAR 未启用）",
  description: "DCAR 未启用时使用只读权限；启用后恢复 Con's 自动审查。",
});

export function isDormantPreset(spec) {
  return spec && Object.entries(DORMANT_PRESET).every(([key, value]) => spec[key] === value);
}

/** Publish a live review preset and, for CAutoR, a guarded native default entry. */
export function registerReviewPreset(service, entries, name, spec, admit) {
  const table = service.presets;
  const previous = name === "CAutoR" ? Object.getOwnPropertyDescriptor(table, name) : undefined;
  const dormant = name === "CAutoR" && isDormantPreset(previous?.value);
  if ((service.names.includes(name) && !dormant) || name === "auto" || name === "custom")
    throw new Error(`DCAR preset ${name} already exists or is reserved`);
  if (entries.has(name)) throw new Error(`DCAR preset ${name} already exists or is reserved`);
  if (name === "CAutoR")
    Object.defineProperty(table, name, { value: DORMANT_PRESET, configurable: true, enumerable: true, writable: true });
  entries.set(name, { spec: Object.freeze({ ...spec }), admit });
  const restore = (keepDefault) => {
    if (name !== "CAutoR") return;
    if (previous) Object.defineProperty(table, name, previous);
    else if (!keepDefault) Reflect.deleteProperty(table, name);
  };
  try { service.emitCatalogChanged(); }
  catch (error) { entries.delete(name); restore(false); throw error; }
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const keepDefault = name === "CAutoR" && service.defaultPreset === name;
    entries.delete(name);
    restore(keepDefault);
    service.emitCatalogChanged();
  };
}

/** Persist a confined CAutoR entry through the host's normal config editor. */
const persistenceKey = Symbol.for("dcar.default-persistence");
export function attachDefaultPersistence(editor, service, admit) {
  const provider = Object.getOwnPropertyDescriptor(service, "ctx")?.value?.fiber;
  if (!provider) return () => {};
  let registry = Object.getOwnPropertyDescriptor(editor, persistenceKey)?.value;
  if (!registry) {
    const previous = Object.getOwnPropertyDescriptor(editor, "edit");
    let original;
    for (let object = editor; object; object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, "edit");
      if (descriptor) { original = descriptor.value; break; }
    }
    if (typeof original !== "function") return () => {};
    if (previous && !previous.configurable) throw new Error("DCAR cannot extend this config editor instance");
    const handlers = new Map();
    const wrapper = function (entry, change) {
      const handler = handlers.get(entry.fiber);
      if (!handler) return original.call(this, entry, change);
      return original.call(this, entry, (current, inherited) => {
        const next = change(current, inherited);
        if ((next.defaultPreset ?? inherited.defaultPreset) !== "CAutoR") return next;
        handler.admit();
        const presets = next.presets ?? inherited.presets ?? handler.service.presets;
        return { ...next, presets: { ...presets, CAutoR: { ...DORMANT_PRESET } } };
      });
    };
    registry = { handlers, wrapper, previous };
    Object.defineProperty(editor, "edit", { value: wrapper, configurable: true });
    Object.defineProperty(editor, persistenceKey, { value: registry, configurable: true });
  }
  const handler = { service, admit };
  registry.handlers.set(provider, handler);
  return () => {
    if (registry.handlers.get(provider) !== handler) return;
    registry.handlers.delete(provider);
    if (registry.handlers.size) return;
    if (Object.getOwnPropertyDescriptor(editor, "edit")?.value === registry.wrapper) {
      if (registry.previous) Object.defineProperty(editor, "edit", registry.previous);
      else Reflect.deleteProperty(editor, "edit");
    }
    Reflect.deleteProperty(editor, persistenceKey);
  };
}
