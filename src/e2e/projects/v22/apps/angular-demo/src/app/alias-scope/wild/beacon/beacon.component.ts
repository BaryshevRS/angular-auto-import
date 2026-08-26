import { Component } from '@angular/core';

/**
 * Reached through `@wild/*`, whose `*` sits in the middle of the mapped path. Such an
 * entry cannot be turned back into a specifier by appending what was not consumed, so
 * the import is written as a relative path instead.
 */
@Component({
  selector: 'app-wild-beacon',
  template: '<span class="beacon"></span>',
})
export class WildBeaconComponent {}
