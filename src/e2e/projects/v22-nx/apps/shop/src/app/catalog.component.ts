import { Component } from '@angular/core';
import { MoneyPipe } from '@shop/data-access';
import { BadgeComponent, HighlightDirective } from '@shop/ui-kit';

@Component({
  selector: 'app-catalog',
  imports: [BadgeComponent, HighlightDirective, MoneyPipe],
  templateUrl: './catalog.component.html',
})
export class CatalogComponent {}
