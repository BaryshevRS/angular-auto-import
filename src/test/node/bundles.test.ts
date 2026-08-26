import * as assert from "node:assert";
import { Project } from "ts-morph";
import { bundleMembersOf } from "../../core/bundles";

/** The declaration the exported name resolves to, as the index reads it. */
function declarationOf(source: string, name: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("/lib/index.d.ts", source, { overwrite: true });
  const declarations = file.getExportedDeclarations().get(name);
  assert.ok(declarations && declarations.length > 0, `nothing exported as ${name}`);
  return declarations[0];
}

describe("Bundles", () => {
  it("reads the tuple a published library ships", () => {
    const declared = declarationOf(
      `
export declare class ComboBoxDirective {}
export declare class LabelDirective {}
export declare const ComboBox: readonly [typeof ComboBoxDirective, typeof LabelDirective];
`,
      "ComboBox"
    );

    assert.deepStrictEqual(
      bundleMembersOf(declared).map((member) => member.name),
      ["ComboBoxDirective", "LabelDirective"]
    );
  });

  it("reads a tuple whose members are named through the file they came from", () => {
    const declared = declarationOf(
      `
import * as i1 from './combo-box';
export declare const ComboBox: readonly [typeof i1.ComboBoxDirective];
`,
      "ComboBox"
    );

    assert.deepStrictEqual(
      bundleMembersOf(declared).map((member) => member.name),
      ["ComboBoxDirective"]
    );
  });

  it("reads the array a workspace library writes", () => {
    const declared = declarationOf(
      `
export class CardComponent {}
export class CardDirective {}
export const Card = [CardComponent, CardDirective] as const;
`,
      "Card"
    );

    assert.deepStrictEqual(
      bundleMembersOf(declared).map((member) => member.name),
      ["CardComponent", "CardDirective"]
    );
  });

  it("holds nothing for a class, and nothing for a value that is not a list of them", () => {
    assert.deepStrictEqual(bundleMembersOf(declarationOf("export declare class Card {}", "Card")), []);
    assert.deepStrictEqual(bundleMembersOf(declarationOf("export const size = 12;", "size")), []);
    assert.deepStrictEqual(
      bundleMembersOf(declarationOf("export declare const sizes: readonly ['s', 'm'];", "sizes")),
      [],
      "a tuple of values is not a tuple of classes"
    );
  });
});
