import { Component } from '@angular/core';

/**
 * The host for the completion e2e cases.
 *
 * It imports nothing on purpose: every case asks what the extension offers for a
 * template that still needs the element, which is the state a user is in when they
 * reach for completion in the first place.
 */
@Component({
  selector: 'app-completion-host',
  imports: [],
  templateUrl: './completion-host.component.html',
})
export class CompletionHostComponent {
  value = 1024;
  visible = true;
  count = 10;
}
