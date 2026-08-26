import { Component } from '@angular/core';

@Component({
  selector: 'lib-badge',
  template: '<span class="badge"><ng-content></ng-content></span>',
})
export class BadgeComponent {}
