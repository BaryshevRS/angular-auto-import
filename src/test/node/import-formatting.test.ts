import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_IMPORT_FORMATTING } from "../../core/import-planner";
import { resolveImportFormatting } from "../../lsp/import-formatting";

describe("Import formatting", () => {
  let sandbox: string;
  let componentPath: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-formatting-"));
    componentPath = path.join(sandbox, "src", "app.component.ts");
    await fs.mkdir(path.dirname(componentPath), { recursive: true });
    await fs.writeFile(componentPath, "export class AppComponent {}\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("uses the closest Prettier configuration", async () => {
    await fs.writeFile(
      path.join(sandbox, ".prettierrc"),
      JSON.stringify({ printWidth: 96, tabWidth: 4, useTabs: true, singleQuote: true }),
      "utf8"
    );

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 96,
      tabWidth: 4,
      useTabs: true,
      singleQuote: true,
    });
  });

  it("also resolves supported EditorConfig values", async () => {
    await fs.writeFile(
      path.join(sandbox, ".editorconfig"),
      "root = true\n\n[*]\nindent_style = space\nindent_size = 6\nmax_line_length = 88\n",
      "utf8"
    );

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      ...DEFAULT_IMPORT_FORMATTING,
      printWidth: 88,
      tabWidth: 6,
      useTabs: false,
      singleQuote: false,
    });
  });

  it("uses Prettier defaults for options omitted by an existing config", async () => {
    await fs.writeFile(path.join(sandbox, ".prettierrc"), JSON.stringify({ singleQuote: true }), "utf8");

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      singleQuote: true,
    });
  });

  it("preserves the extension's existing formatting when no project config exists", async () => {
    assert.deepStrictEqual(await resolveImportFormatting(componentPath), DEFAULT_IMPORT_FORMATTING);
  });

  it("reads the configuration a package.json carries instead of a file of its own", async () => {
    await fs.writeFile(
      path.join(sandbox, "package.json"),
      JSON.stringify({ name: "sandbox", prettier: { tabWidth: 8, singleQuote: true } }),
      "utf8"
    );

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 80,
      tabWidth: 8,
      useTabs: false,
      singleQuote: true,
    });
  });

  it("takes the closest configuration when several sit above the component", async () => {
    await fs.writeFile(path.join(sandbox, ".prettierrc"), JSON.stringify({ printWidth: 96 }), "utf8");
    await fs.writeFile(
      path.join(sandbox, "src", ".prettierrc"),
      JSON.stringify({ printWidth: 70, singleQuote: true }),
      "utf8"
    );

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 70,
      tabWidth: 2,
      useTabs: false,
      singleQuote: true,
    });
  });

  it("assumes Prettier's defaults for a configuration written as code", async () => {
    await fs.writeFile(path.join(sandbox, "prettier.config.js"), "module.exports = { printWidth: 200 };\n", "utf8");

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      singleQuote: false,
    });
  });

  it("lets a Prettier configuration override what EditorConfig said", async () => {
    await fs.writeFile(
      path.join(sandbox, ".editorconfig"),
      "root = true\n\n[*]\nindent_size = 6\nmax_line_length = 88\n",
      "utf8"
    );
    await fs.writeFile(path.join(sandbox, ".prettierrc"), JSON.stringify({ printWidth: 96 }), "utf8");

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 96,
      tabWidth: 6,
      useTabs: false,
      singleQuote: false,
    });
  });

  it("applies only the EditorConfig sections that match the component", async () => {
    await fs.writeFile(
      path.join(sandbox, ".editorconfig"),
      [
        "root = true",
        "",
        "[*]",
        "indent_style = tab",
        "indent_size = 8",
        "",
        "[*.md]",
        "max_line_length = 200",
        "",
        "[*.{ts,html}]",
        "indent_size = 3",
        "",
      ].join("\n"),
      "utf8"
    );

    assert.deepStrictEqual(await resolveImportFormatting(componentPath), {
      printWidth: 80,
      tabWidth: 3,
      useTabs: true,
      singleQuote: false,
    });
  });
});
