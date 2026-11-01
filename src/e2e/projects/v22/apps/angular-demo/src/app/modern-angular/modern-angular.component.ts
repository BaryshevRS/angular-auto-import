import { AsyncPipe, JsonPipe, LowerCasePipe, SlicePipe, UpperCasePipe } from '@angular/common';
import { Toolbar, ToolbarWidget } from '@angular/aria/toolbar';
import { Component, signal } from '@angular/core';
import { FormField, FormRoot, form } from '@angular/forms/signals';
import { UiDemoOneComponent } from '@angular-demo/ui-demo-one';
import { of } from 'rxjs';

@Component({
  selector: 'app-modern-angular',
  templateUrl: './modern-angular.component.html',
  imports: [AsyncPipe, JsonPipe, LowerCasePipe, SlicePipe, UpperCasePipe, Toolbar, ToolbarWidget, FormField, FormRoot, UiDemoOneComponent],
})
export class ModernAngularComponent {
  readonly user = signal({ name: '' });
  readonly userForm = form(this.user);
  readonly ready$ = of(true);
  readonly prefetchReady$ = of(true);
  readonly hydrateReady$ = of(true);
  readonly name = 'Angular';
  readonly count = 1;
  readonly items = ['Angular', 'Aria'];
  readonly mode: 'one' | 'two' = 'one';

  tag(strings: TemplateStringsArray, value: string): string {
    return strings[0] + value;
  }
}
