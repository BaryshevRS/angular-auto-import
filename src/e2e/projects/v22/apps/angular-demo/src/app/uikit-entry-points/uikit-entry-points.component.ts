import { Component } from '@angular/core';
import { FixtureSvgModule } from '@fixture/uikit/components/svg';

/**
 * The module is imported from the entry point that declares it, while the same class is
 * also reachable through `@fixture/uikit/components` and `@fixture/uikit`. One module,
 * three ways in — and the element it exports is available whichever one was written.
 */
@Component({
  selector: 'app-uikit-entry-points',
  standalone: true,
  imports: [FixtureSvgModule],
  templateUrl: './uikit-entry-points.component.html',
})
export class UikitEntryPointsComponent {}
