/**
 * Tests for forms configuration to ensure selectors work correctly
 * with Trie-based prefix matching.
 */

import * as assert from "node:assert";
import { describe, it } from "mocha";
import { FORMS_DIRECTIVES, REACTIVE_FORMS_DIRECTIVES } from "../../config/forms";

describe("Forms Configuration", () => {
  describe("REACTIVE_FORMS_DIRECTIVES", () => {
    it("should include both bracketed and non-bracketed variants for all directives", () => {
      const requiredDirectives = [
        { name: "formControl", bracketed: "[formControl]" },
        { name: "formControlName", bracketed: "[formControlName]" },
        { name: "formGroup", bracketed: "[formGroup]" },
        { name: "formGroupName", bracketed: "[formGroupName]" },
        { name: "formArrayName", bracketed: "[formArrayName]" },
      ];

      for (const { name, bracketed } of requiredDirectives) {
        const directive = REACTIVE_FORMS_DIRECTIVES.find((d) => d.selectors.includes(name));

        assert.ok(directive, `Should have directive for ${name}`);
        assert.ok(
          directive?.selectors.includes(name),
          `${name} directive should include non-bracketed selector '${name}'`
        );
        assert.ok(
          directive?.selectors.includes(bracketed),
          `${name} directive should include bracketed selector '${bracketed}'`
        );
      }
    });

    it("should have ReactiveFormsModule as name for all directives", () => {
      for (const directive of REACTIVE_FORMS_DIRECTIVES) {
        assert.strictEqual(
          directive.name,
          "ReactiveFormsModule",
          `All reactive forms directives should reference ReactiveFormsModule, got: ${directive.name}`
        );
      }
    });

    it("should have correct importPath for all directives", () => {
      for (const directive of REACTIVE_FORMS_DIRECTIVES) {
        assert.strictEqual(
          directive.importPath,
          "@angular/forms",
          `Import path should be @angular/forms, got: ${directive.importPath}`
        );
      }
    });

    it("should mark all directives as non-standalone", () => {
      for (const directive of REACTIVE_FORMS_DIRECTIVES) {
        assert.strictEqual(
          directive.standalone,
          false,
          `Reactive forms directives should not be standalone, got: ${directive.standalone}`
        );
      }
    });

    it("should have directive type for all entries", () => {
      for (const directive of REACTIVE_FORMS_DIRECTIVES) {
        assert.strictEqual(directive.type, "directive", `Type should be 'directive', got: ${directive.type}`);
      }
    });
  });

  describe("FORMS_DIRECTIVES", () => {
    it("should include both bracketed and non-bracketed variants for ngModel", () => {
      const ngModelDirective = FORMS_DIRECTIVES.find((d) => d.selectors.includes("ngModel"));

      assert.ok(ngModelDirective, "Should have ngModel directive");
      assert.ok(
        ngModelDirective?.selectors.includes("ngModel"),
        "ngModel directive should include non-bracketed selector"
      );
      assert.ok(
        ngModelDirective?.selectors.includes("[ngModel]"),
        "ngModel directive should include bracketed selector"
      );
    });

    it("should have FormsModule as name for all directives", () => {
      for (const directive of FORMS_DIRECTIVES) {
        assert.strictEqual(
          directive.name,
          "FormsModule",
          `All template-driven forms directives should reference FormsModule, got: ${directive.name}`
        );
      }
    });

    it("should have correct importPath for all directives", () => {
      for (const directive of FORMS_DIRECTIVES) {
        assert.strictEqual(
          directive.importPath,
          "@angular/forms",
          `Import path should be @angular/forms, got: ${directive.importPath}`
        );
      }
    });

    it("should mark all directives as non-standalone", () => {
      for (const directive of FORMS_DIRECTIVES) {
        assert.strictEqual(
          directive.standalone,
          false,
          `Template-driven forms directives should not be standalone, got: ${directive.standalone}`
        );
      }
    });
  });

  describe("Trie Prefix Matching Compatibility", () => {
    it("should support prefix search for 'formGroup' (without brackets)", () => {
      const formGroupDirective = REACTIVE_FORMS_DIRECTIVES.find((d) => d.selectors.includes("formGroup"));

      assert.ok(formGroupDirective, "Should find formGroup directive");
      assert.ok(
        formGroupDirective?.selectors.some((s) => s.startsWith("formGroup")),
        "Should have a selector starting with 'formGroup' for Trie prefix matching"
      );
    });

    it("should support prefix search for '[formGroup]' (with brackets)", () => {
      const formGroupDirective = REACTIVE_FORMS_DIRECTIVES.find((d) => d.selectors.includes("[formGroup]"));

      assert.ok(formGroupDirective, "Should find [formGroup] directive");
      assert.ok(
        formGroupDirective?.selectors.some((s) => s.startsWith("[formGroup]")),
        "Should have a selector starting with '[formGroup]' for Trie prefix matching"
      );
    });

    it("should not have complex pseudo-selectors in selectors array", () => {
      const allDirectives = [...FORMS_DIRECTIVES, ...REACTIVE_FORMS_DIRECTIVES];

      for (const directive of allDirectives) {
        for (const selector of directive.selectors) {
          assert.ok(
            !selector.includes(":not("),
            `Selector '${selector}' should not contain :not() pseudo-selector in selectors array (should be in originalSelector only)`
          );
        }
      }
    });

    it("should preserve complex selectors in originalSelector field", () => {
      const ngModelDirective = FORMS_DIRECTIVES.find((d) => d.selectors.includes("ngModel"));

      assert.ok(ngModelDirective, "Should have ngModel directive");
      assert.ok(
        ngModelDirective?.originalSelector?.includes(":not("),
        "originalSelector should preserve :not() pseudo-selectors"
      );
    });
  });
});
