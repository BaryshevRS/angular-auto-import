import { NgModule } from '@angular/core';
import { LeftBadgeComponent } from './left-badge.component';

/** One of two modules called SharedModule; this one exports only the left badge. */
@NgModule({
  declarations: [LeftBadgeComponent],
  exports: [LeftBadgeComponent],
})
export class SharedModule {}
