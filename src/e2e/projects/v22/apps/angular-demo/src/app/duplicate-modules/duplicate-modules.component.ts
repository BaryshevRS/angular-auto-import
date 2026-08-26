import { Component } from '@angular/core';
import { SharedModule } from '@dup/left';

/**
 * Imports one of the two SharedModules, through a tsconfig alias, so the left badge is
 * available and the right one — exported by the module of the same name next door — is not.
 */
@Component({
  selector: 'app-duplicate-modules',
  standalone: true,
  imports: [SharedModule],
  templateUrl: './duplicate-modules.component.html',
})
export class DuplicateModulesComponent {}
