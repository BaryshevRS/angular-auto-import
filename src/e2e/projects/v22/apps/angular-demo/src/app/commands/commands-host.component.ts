import { Component } from '@angular/core';

/**
 * The host for the palette command cases.
 *
 * It imports nothing on purpose: a template that needs an element is how those cases
 * ask the server a question only a working index can answer.
 */
@Component({
  selector: 'app-commands-host',
  imports: [],
  templateUrl: './commands-host.component.html',
})
export class CommandsHostComponent {}
