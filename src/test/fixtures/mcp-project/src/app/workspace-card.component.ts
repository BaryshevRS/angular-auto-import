import { Component, input, output } from "@angular/core";

@Component({
  selector: "workspace-card",
  standalone: true,
  template: '<ng-content select="[actions]" />',
})
export class WorkspaceCardComponent {
  readonly heading = input.required<string>({ alias: "cardTitle" });
  readonly dismissed = output<void>();
}
