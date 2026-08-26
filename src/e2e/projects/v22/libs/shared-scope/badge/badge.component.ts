import { Component } from '@angular/core';

/**
 * A library reached through a wildcard alias that names a directory rather than a
 * barrel: the import specifier is the alias plus whatever the alias did not consume.
 */
@Component({
  selector: 'lib-shared-badge',
  template: '<span class="badge"><ng-content></ng-content></span>',
})
export class SharedBadgeComponent {}
