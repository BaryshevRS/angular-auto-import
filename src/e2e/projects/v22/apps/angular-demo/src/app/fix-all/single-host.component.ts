import { Component } from '@angular/core';

/**
 * The host for the fix-all command case that is missing one element.
 *
 * A file missing a single import is the commonest there is, and it is the one the
 * command used to answer "no auto-import diagnostics to fix", so it gets a case — and a
 * host of its own, untouched by the case that fixes two.
 */
@Component({
  selector: 'app-fix-all-single-host',
  imports: [],
  templateUrl: './single-host.component.html',
})
export class FixAllSingleHostComponent {}
