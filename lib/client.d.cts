window.__ModuleLoader__.load({
  id: "cc-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

import { Context } from "@deepseek-ai/cordis";
//#region src/client/index.d.ts
declare function apply(ctx: Context): void;
//#endregion
export { apply };

    return module.exports;
  }
});
