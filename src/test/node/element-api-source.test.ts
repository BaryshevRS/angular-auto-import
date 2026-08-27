/**
 * Reading an element's surface out of the source a project writes.
 *
 * A published element arrives compiled and normalized; a project's own arrives in
 * whichever of four spellings its author used. These are the spellings, and the fixture
 * projects under `src/e2e/projects` use every one of them.
 * @module
 */

import * as assert from "node:assert";
import { Project } from "ts-morph";
import { readElementApiFromSource } from "../../core/element-api-source";
import type { ElementInput, ElementOutput } from "../../types";

/** The surface of the one class in a fragment of Angular source. */
function apiOf(source: string): { inputs: ElementInput[]; outputs: ElementOutput[] } {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("/src/app/thing.component.ts", source, { overwrite: true });
  const [classDeclaration] = file.getClasses();
  const { inputs, outputs } = readElementApiFromSource(classDeclaration);
  return { inputs, outputs };
}

describe("Element API, out of the source", () => {
  it("reads a decorated input and output", () => {
    const { inputs, outputs } = apiOf(`
      @Component({ selector: 'app-card' })
      export class CardComponent {
        @Input() heading!: string;
        @Output() closed = new EventEmitter<void>();
      }
    `);

    assert.deepStrictEqual(inputs, [{ name: "heading", propertyName: undefined, required: false, isSignal: false }]);
    assert.deepStrictEqual(outputs, [{ name: "closed", propertyName: undefined }]);
  });

  it("takes the alias from either form the decorator accepts", () => {
    const { inputs, outputs } = apiOf(`
      @Directive({ selector: '[appThing]' })
      export class ThingDirective {
        @Input('appHeading') heading!: string;
        @Input({ alias: 'appSize', required: true }) size!: number;
        @Output('appClosed') closed = new EventEmitter<void>();
      }
    `);

    assert.deepStrictEqual(inputs, [
      { name: "appHeading", propertyName: "heading", required: false, isSignal: false },
      { name: "appSize", propertyName: "size", required: true, isSignal: false },
    ]);
    assert.deepStrictEqual(outputs, [{ name: "appClosed", propertyName: "closed" }]);
  });

  it("reads a decorator that carries options but no alias", () => {
    const { inputs } = apiOf(`
      @Directive({ selector: '[appThing]' })
      export class ThingDirective {
        @Input({ required: true, transform: booleanAttribute }) disabled!: boolean;
      }
    `);

    assert.deepStrictEqual(inputs, [{ name: "disabled", propertyName: undefined, required: true, isSignal: false }]);
  });

  it("reads the signal functions, and which of them is required", () => {
    const { inputs, outputs } = apiOf(`
      import { Component, input, output } from '@angular/core';

      @Component({ selector: 'app-card' })
      export class CardComponent {
        heading = input.required<string>();
        tone = input('quiet');
        size = input(123, { alias: 'appSize' });
        closed = output<void>();
        opened = output({ alias: 'appOpened' });
      }
    `);

    assert.deepStrictEqual(inputs, [
      { name: "heading", propertyName: undefined, required: true, isSignal: true },
      { name: "tone", propertyName: undefined, required: false, isSignal: true },
      { name: "appSize", propertyName: "size", required: false, isSignal: true },
    ]);
    assert.deepStrictEqual(outputs, [
      { name: "closed", propertyName: undefined },
      { name: "appOpened", propertyName: "opened" },
    ]);
  });

  it("gives a model both halves, which is what makes it two-way", () => {
    const { inputs, outputs } = apiOf(`
      import { Component, model } from '@angular/core';

      @Component({ selector: 'app-card' })
      export class CardComponent {
        value = model('');
        checked = model.required<boolean>();
        state = model(0, { alias: 'appState' });
      }
    `);

    assert.deepStrictEqual(
      inputs.map(({ name, required }) => [name, required]),
      [
        ["value", false],
        ["checked", true],
        ["appState", false],
      ]
    );
    assert.deepStrictEqual(outputs, [
      // The output belongs to the same property as the input: `value = model()` emits an
      // output map of `{ "value": "valueChange" }`, and no `valueChange` field exists.
      { name: "valueChange", propertyName: "value" },
      { name: "checkedChange", propertyName: "checked" },
      { name: "appStateChange", propertyName: "state" },
    ]);
  });

  it("does not mistake an object default for an options object", () => {
    // `input(initialValue, opts?)` keeps options second; `input.required(opts?)` keeps
    // them first, having no initial value to hold. Reading the last object literal makes
    // this default look like an alias, and the input vanishes under a name nothing binds.
    const { inputs } = apiOf(`
      import { Component, input, model } from '@angular/core';

      @Component({ selector: 'app-card' })
      export class CardComponent {
        settings = input({ alias: 'dark' });
        layout = model({ alias: 'wide' });
        strict = input.required({ alias: 'appStrict' });
      }
    `);

    assert.deepStrictEqual(inputs, [
      { name: "settings", propertyName: undefined, required: false, isSignal: true },
      { name: "layout", propertyName: undefined, required: false, isSignal: true },
      { name: "appStrict", propertyName: "strict", required: true, isSignal: true },
    ]);
  });

  it("reads the object form of the decorator's inputs array", () => {
    // `inputs` takes strings or objects; `outputs` takes strings only.
    const { inputs } = apiOf(`
      import { Directive, numberAttribute } from '@angular/core';

      @Directive({
        selector: '[appThing]',
        inputs: [{ name: 'id', alias: 'account-id', required: true, transform: numberAttribute }, { name: 'tone' }],
      })
      export class ThingDirective {}
    `);

    assert.deepStrictEqual(inputs, [
      { name: "account-id", propertyName: "id", required: true, isSignal: false },
      { name: "tone", propertyName: undefined, required: false, isSignal: false },
    ]);
  });

  it("follows a renamed or namespaced import to the same declaration", () => {
    const { inputs, outputs } = apiOf(`
      import { Component, input as ngInput } from '@angular/core';
      import * as core from '@angular/core';
      import { outputFromObservable } from '@angular/core/rxjs-interop';

      @Component({ selector: 'app-card' })
      export class CardComponent {
        heading = ngInput.required<string>();
        tone = core.input('quiet', { alias: 'appTone' });
        closed = outputFromObservable(this.source$, { alias: 'appClosed' });
      }
    `);

    assert.deepStrictEqual(inputs, [
      { name: "heading", propertyName: undefined, required: true, isSignal: true },
      { name: "appTone", propertyName: "tone", required: false, isSignal: true },
    ]);
    assert.deepStrictEqual(outputs, [{ name: "appClosed", propertyName: "closed" }]);
  });

  it("says nothing about a local function that merely shares the name", () => {
    // Where `input` came from is the whole question: a project's own helper of that name
    // declares nothing, however much the call looks like Angular's.
    const { inputs } = apiOf(`
      import { Component } from '@angular/core';
      import { input } from './form-helpers';

      @Component({ selector: 'app-card' })
      export class CardComponent {
        heading = input('x');
      }
    `);

    assert.deepStrictEqual(inputs, []);
  });

  it("reads a binding declared on the class decorator instead of the field", () => {
    // `@Directive({ inputs: ['size: appSize'] })` is the same declaration as
    // `@Input('appSize') size`, and Angular reads both through `parseMappingString`:
    // the field first, then the name a template writes.
    const { inputs, outputs } = apiOf(`
      @Directive({ selector: '[appThing]', inputs: ['size: appSize', 'tone'], outputs: ['closed: appClosed'] })
      export class ThingDirective {}
    `);

    assert.deepStrictEqual(inputs, [
      { name: "appSize", propertyName: "size", required: false, isSignal: false },
      { name: "tone", propertyName: undefined, required: false, isSignal: false },
    ]);
    assert.deepStrictEqual(outputs, [{ name: "appClosed", propertyName: "closed" }]);
  });

  it("reads a decorator on a setter, which is where a transform used to live", () => {
    const { inputs } = apiOf(`
      @Directive({ selector: '[appThing]' })
      export class ThingDirective {
        @Input('appDisabled') set disabled(value: string) { this._disabled = value === ''; }
      }
    `);

    assert.deepStrictEqual(inputs, [
      { name: "appDisabled", propertyName: "disabled", required: false, isSignal: false },
    ]);
  });

  it("says nothing about a field that only looks like a declaration", () => {
    const { inputs, outputs } = apiOf(`
      import { Component, computed, inject, viewChild } from '@angular/core';

      @Component({ selector: 'app-card' })
      export class CardComponent {
        private readonly service = inject(CardService);
        readonly row = viewChild<ElementRef>('row');
        readonly label = computed(() => 'x');
      }
    `);

    assert.deepStrictEqual(inputs, []);
    assert.deepStrictEqual(outputs, []);
  });

  it("reads an alias written with backticks, which Angular treats as a string", () => {
    // ngtsc's evaluator answers `isNoSubstitutionTemplateLiteral(node) -> node.text`
    // beside the quoted case, so every spelling below names what it says.
    const { inputs, outputs } = apiOf(
      [
        "import { Directive, Input, Output, input } from '@angular/core';",
        "",
        "@Directive({",
        "  selector: '[appThing]',",
        "  inputs: [`legacy: appLegacy`, { name: 'id', alias: `account-id` }],",
        "  outputs: [`closed: appClosed`],",
        "})",
        "export class ThingDirective {",
        "  @Input(`appHeading`) heading!: string;",
        "  @Input({ alias: `appSize` }) size!: number;",
        "  value = input(0, { alias: `appValue` });",
        "  @Output(`appOpened`) opened = new EventEmitter<void>();",
        "}",
      ].join("\n")
    );

    assert.deepStrictEqual(
      inputs.map(({ name, propertyName }) => [name, propertyName]),
      [
        ["appLegacy", "legacy"],
        ["account-id", "id"],
        ["appHeading", "heading"],
        ["appSize", "size"],
        ["appValue", "value"],
      ]
    );
    assert.deepStrictEqual(
      outputs.map((output) => output.name),
      ["appClosed", "appOpened"]
    );
  });

  it("says nothing about an alias it would have to compute", () => {
    // ngtsc resolves an interpolated name where every part is statically known, which
    // means evaluating expressions. A name this module cannot see is left absent rather
    // than guessed, and the property name stands.
    const { inputs } = apiOf(
      [
        "import { Component, input } from '@angular/core';",
        "const PREFIX = 'app';",
        "",
        "@Component({ selector: 'app-card' })",
        "export class CardComponent {",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the Angular source under test, not this file's.
        "  size = input(0, { alias: `${PREFIX}Size` });",
        "}",
      ].join("\n")
    );

    assert.deepStrictEqual(inputs, [{ name: "size", propertyName: undefined, required: false, isSignal: true }]);
  });
});
