import { Component } from '@angular/core';
import { MoneyPipe } from '@shop/data-access';

@Component({
  selector: 'lib-project-wide-fix-all-owner',
  standalone: true,
  imports: [MoneyPipe],
  templateUrl: './lib-owner.component.html',
})
export class ProjectWideFixAllLibOwnerComponent {}
