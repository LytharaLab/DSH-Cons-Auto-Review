/**
 * DSH 0.1.7-rc.2 / 0.2.0-rc.2 permission service adapter.
 * Adds effect-scoped review presets without changing DSH's built-in knob setters,
 * /permission command, session projection, catalog Remote, or official Auto integration.
 */
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import { registerReviewPreset } from "./preset-defaults.js";
function entries(service) {
  return service.dcarReviewPresets;
}
export default class DCARPermissionPresetService extends PermissionPresetService {
  constructor(ctx, config) {
    for (const method of ["specOf", "derive", "apply", "emitCatalogChanged"])
      if (typeof PermissionPresetService.prototype[method] !== "function")
        throw new Error(
          `DCAR permission adapter requires DSH 0.1.7-rc.2 or 0.2.0-rc.2 (${method} is unavailable)`,
        );
    super(ctx, config);
    this.dcarReviewPresets = new Map();
    // A restored CAutoR session cannot execute while its review provider is absent.
    ctx.inject(["tools"], (child) => {
      child.on(
        "tools/pre-execute",
        async (exec, next) => {
          if (exec.agent) {
            const state = ctx.sessionProjections.stateOf(
              exec.agent.session,
              "permissions",
            );
            if (
              state?.preset === "CAutoR" &&
              state.sandbox === "danger-full-access" &&
              !entries(this)?.has("CAutoR")
            )
              return {
                kind: "deny",
                reason:
                  "CAutoR review provider is unavailable; select workspace-write or enable DCAR.",
                info: {
                  name: "DCARUnavailableError",
                  code: "DCAR_UNAVAILABLE",
                },
              };
          }
          return next();
        },
        { prepend: true },
      );
    });
  }
  get names() {
    return [...new Set([...super.names, ...(entries(this)?.keys() ?? [])])];
  }
  specOf(name) {
    return entries(this)?.get(name)?.spec ?? super.specOf(name);
  }
  derive(state) {
    const entry =
      state.preset === null ? undefined : entries(this)?.get(state.preset);
    if (
      entry &&
      state.sandbox === entry.spec.sandbox &&
      (state.approval === entry.spec.approval || state.approval === "never")
    )
      return state.preset;
    const derived = super.derive(state);
    return derived === "CAutoR" && entries(this)?.has("CAutoR") ? "custom" : derived;
  }
  apply(session, name, setApproval) {
    entries(this)?.get(name)?.admit();
    return super.apply(session, name, setApproval);
  }
  /** Register an effect-owned custom review mode and its synchronous selection guard. */
  registerReviewPreset(name, spec, admit) {
    return registerReviewPreset(this, entries(this), name, spec, admit);
  }
}
