import { Component } from '@angular/core';
import { HoistedCardComponent } from '@fixture/hoisted-ui';

@Component({
  selector: 'app-hoisted-host',
  imports: [HoistedCardComponent],
  templateUrl: './hoisted-host.component.html',
})
export class HoistedHostComponent {}
