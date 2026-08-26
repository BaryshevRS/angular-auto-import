import { Component } from '@angular/core';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { SharedBadgeComponent } from '@shared/badge/badge.component';
import { WildBeaconComponent } from './wild/beacon/beacon.component';

@Component({
  selector: 'app-alias-scope',
  imports: [SharedBadgeComponent, WildBeaconComponent],
  templateUrl: './alias-scope.component.html',
})
export class AliasScopeComponent {}
