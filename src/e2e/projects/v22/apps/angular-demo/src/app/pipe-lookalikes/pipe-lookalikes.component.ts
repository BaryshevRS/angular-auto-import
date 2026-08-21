import { Component } from '@angular/core';

/**
 * Reproduction for the false `missing-pipe-import` reported in issue #34, and for the
 * two cases found while fixing it.
 *
 * The workspace declares a pipe named `bytes`. This component does not import it, so
 * every real use of it below must be reported — and none of the look-alikes may be,
 * even though each one puts the same name after a bar.
 */
@Component({
  selector: 'app-pipe-lookalikes',
  standalone: true,
  templateUrl: './pipe-lookalikes.component.html',
  imports: [],
})
export class PipeLookalikesComponent {
  readonly size = 1024;
  readonly label = 'a';
  readonly isLarge = false;

  /** Named after the pipe on purpose: `isLarge || bytes` is an OR, not a pipe. */
  readonly bytes = 'not the pipe';
}
