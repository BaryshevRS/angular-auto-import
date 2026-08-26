import { NgModule } from '@angular/core';
import { RightBadgeComponent } from './right-badge.component';

/** The other SharedModule: same class name, different exports. */
@NgModule({
  declarations: [RightBadgeComponent],
  exports: [RightBadgeComponent],
})
export class SharedModule {}
