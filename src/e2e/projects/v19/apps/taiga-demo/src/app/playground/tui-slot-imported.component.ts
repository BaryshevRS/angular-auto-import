import { Component } from '@angular/core';
import { TuiBlockStatusComponent, TuiBlockStatusDirective } from '@taiga-ui/layout';
import { TuiAvatar } from '@taiga-ui/kit';

/**
 * `tuiSlot` is the selector of more than one directive, and this file imports one of
 * them — so the attribute has an owner and must not be reported. Everything else the
 * template uses is imported too: a fixture a maintainer opens should carry no warnings,
 * and `pnpm run test:fixtures` is what holds that to it.
 */
@Component({
  selector: 'app-tui-slot-imported',
  standalone: true,
  imports: [TuiBlockStatusComponent, TuiBlockStatusDirective, TuiAvatar],
  templateUrl: './tui-slot-imported.component.html',
})
export class TuiSlotImportedComponent {}
