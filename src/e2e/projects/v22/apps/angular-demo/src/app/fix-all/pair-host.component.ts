import { Component } from '@angular/core';

/**
 * The host for the fix-all command case that is missing two elements.
 *
 * It imports nothing on purpose: the case writes a template needing both and runs the
 * palette command, which has to leave both imports behind. It is a host of its own so
 * that no other case has to put it back before this one can run.
 */
@Component({
  selector: 'app-fix-all-pair-host',
  imports: [],
  templateUrl: './pair-host.component.html',
})
export class FixAllPairHostComponent {}
