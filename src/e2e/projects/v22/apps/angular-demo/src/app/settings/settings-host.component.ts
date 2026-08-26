import { Component } from '@angular/core';

/**
 * The host for the settings cases.
 *
 * It imports nothing on purpose: what a setting does is visible only where there is
 * something to report or complete, and a template missing an element is that.
 */
@Component({
  selector: 'app-settings-host',
  imports: [],
  templateUrl: './settings-host.component.html',
})
export class SettingsHostComponent {}
