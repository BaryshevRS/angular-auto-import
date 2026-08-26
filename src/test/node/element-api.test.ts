/**
 * Reading an element's public surface out of the declaration a library ships.
 *
 * Every declaration below is real emit, copied from the v22 fixture's dependencies and
 * trimmed only in the number of inputs. Writing them by hand from the type's signature
 * is how a reader ends up testing a shape the compiler does not actually produce.
 * @module
 */

import * as assert from "node:assert";
import { Project, SyntaxKind, type TypeReferenceNode } from "ts-morph";
import { type ElementApi, readElementApi } from "../../core/element-api";

/**
 * The surface of the one declaration in a fragment of a `.d.ts`.
 * @param declaration A `static ɵcmp: …` or `static ɵdir: …` line, as emitted.
 */
function apiOf(declaration: string): ElementApi {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile(
    "/node_modules/library/index.d.ts",
    `import * as i0 from "@angular/core";\ndeclare class Thing {\n  ${declaration}\n}\n`,
    { overwrite: true }
  );

  const property = file.getClassOrThrow("Thing").getStaticProperties()[0];
  const typeNode = property.asKindOrThrow(SyntaxKind.PropertyDeclaration).getTypeNodeOrThrow();
  return readElementApi((typeNode as TypeReferenceNode).getTypeArguments());
}

describe("Element API, out of the declaration", () => {
  it("reads signal inputs and an output", () => {
    // ng-zorro's NzCheckListComponent, three of its seven inputs.
    const api = apiOf(
      'static ɵcmp: i0.ɵɵComponentDeclaration<NzCheckListComponent, "nz-check-list", never, ' +
        '{ "nzItems": { "alias": "nzItems"; "required": false; "isSignal": true; }; ' +
        '"nzVisible": { "alias": "nzVisible"; "required": false; "isSignal": true; }; ' +
        '"nzTitle": { "alias": "nzTitle"; "required": false; "isSignal": true; }; }, ' +
        '{ "nzHide": "nzHide"; }, never, never, true, never>;'
    );

    assert.deepStrictEqual(api.inputs, [
      { name: "nzItems", propertyName: undefined, required: false, isSignal: true },
      { name: "nzVisible", propertyName: undefined, required: false, isSignal: true },
      { name: "nzTitle", propertyName: undefined, required: false, isSignal: true },
    ]);
    assert.deepStrictEqual(api.outputs, [{ name: "nzHide", propertyName: undefined }]);
    assert.deepStrictEqual(api.contentSelectors, []);
  });

  it("names an input by its alias, keeping the property it belongs to", () => {
    // ng-zorro's tooltip directive, whose inputs are aliased throughout.
    const api = apiOf(
      'static ɵdir: i0.ɵɵDirectiveDeclaration<NzTooltipDirective, "[nz-tooltip]", ["nzTooltip"], ' +
        '{ "title": { "alias": "nzTooltipTitle"; "required": false; }; ' +
        '"directiveTitle": { "alias": "nz-tooltip"; "required": false; }; }, {}, never, never, true, never>;'
    );

    assert.deepStrictEqual(api.inputs, [
      { name: "nzTooltipTitle", propertyName: "title", required: false, isSignal: false },
      { name: "nz-tooltip", propertyName: "directiveTitle", required: false, isSignal: false },
    ]);
  });

  it("records that an input is required", () => {
    // ng-zorro's tree-view, where both of these refuse to compile unbound.
    const api = apiOf(
      'static ɵdir: i0.ɵɵDirectiveDeclaration<NzTreeVirtualScrollViewDirective, "[nzTreeVirtualScrollView]", never, ' +
        '{ "data": { "alias": "data"; "required": true; }; ' +
        '"compareBy": { "alias": "compareBy"; "required": true; }; }, {}, never, never, true, never>;'
    );

    assert.deepStrictEqual(
      api.inputs.map(({ name, required }) => [name, required]),
      [
        ["data", true],
        ["compareBy", true],
      ]
    );
  });

  it("reads the content selectors a component projects into", () => {
    // Angular Material's MatTable: nothing of its own in either map, because everything
    // it takes is CdkTable's — which is the reason an inherited surface is its own job.
    const api = apiOf(
      'static ɵcmp: i0.ɵɵComponentDeclaration<MatTable<any>, "mat-table, table[mat-table]", ["matTable"], ' +
        '{}, {}, never, ["caption", "colgroup, col", "*"], true, never>;'
    );

    assert.deepStrictEqual(api.inputs, []);
    assert.deepStrictEqual(api.outputs, []);
    assert.deepStrictEqual(api.contentSelectors, ["caption", "colgroup, col", "*"]);
  });

  it("reads an input written as a bare public name", () => {
    // The older emit, which the declaration's type still permits: a string instead of an
    // object, saying the public name and nothing else.
    const api = apiOf(
      'static ɵdir: i0.ɵɵDirectiveDeclaration<Old, "[old]", never, { "value": "oldValue"; }, {}, never, never, false, never>;'
    );

    assert.deepStrictEqual(api.inputs, [{ name: "oldValue", propertyName: "value", required: false, isSignal: false }]);
  });

  it("says nothing rather than guessing when the arguments are not there", () => {
    const api = apiOf('static ɵpipe: i0.ɵɵPipeDeclaration<DatePipe, "date", true>;');

    assert.deepStrictEqual(api, { inputs: [], outputs: [], contentSelectors: [] });
  });
});
