import { Component } from '@angular/core';
import { WildBeaconComponent } from '../../../../libs/wild/beacon/src/beacon.component';

@Component({
  selector: 'app-beacon-host',
  imports: [WildBeaconComponent],
  templateUrl: './beacon-host.component.html',
})
export class BeaconHostComponent {}
