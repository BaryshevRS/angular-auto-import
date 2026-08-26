import { Component } from '@angular/core';
import { NzTableItem, nzTableItems, nzTreeNodes } from '../shared/nz-playground.data';
import { NzContentComponent, NzHeaderComponent, NzLayoutComponent, NzSiderComponent } from 'ng-zorro-antd/layout';
import { NzMenuDirective, NzMenuItemComponent, NzSubMenuComponent } from 'ng-zorro-antd/menu';
import { NzIconDirective } from 'ng-zorro-antd/icon';
import { NzDropdownButtonDirective, NzDropDownDirective, NzDropdownMenuComponent } from 'ng-zorro-antd/dropdown';
import { NzButtonComponent } from 'ng-zorro-antd/button';
import { NzWaveDirective } from 'ng-zorro-antd/core/wave';
import { NzBadgeComponent } from 'ng-zorro-antd/badge';
import { NzAvatarComponent } from 'ng-zorro-antd/avatar';
import { NzBreadCrumbComponent, NzBreadCrumbItemComponent } from 'ng-zorro-antd/breadcrumb';
import { NzColDirective, NzRowDirective } from 'ng-zorro-antd/grid';
import { NzCardComponent } from 'ng-zorro-antd/card';
import { NzTooltipDirective } from 'ng-zorro-antd/tooltip';
import { NzSegmentedComponent } from 'ng-zorro-antd/segmented';
import { FormsModule } from '@angular/forms';
import { NzTagComponent } from 'ng-zorro-antd/tag';
import { NzInputDirective, NzInputGroupComponent } from 'ng-zorro-antd/input';
import { NzOptionComponent, NzSelectComponent } from 'ng-zorro-antd/select';
import {
  NzAutocompleteComponent,
  NzAutocompleteOptionComponent,
  NzAutocompleteTriggerDirective,
} from 'ng-zorro-antd/auto-complete';
import { NzDatePickerComponent } from 'ng-zorro-antd/date-picker';
import { NzTreeSelectComponent } from 'ng-zorro-antd/tree-select';
import { NzSwitchComponent } from 'ng-zorro-antd/switch';
import { NzRadioComponent, NzRadioGroupComponent } from 'ng-zorro-antd/radio';
import { NzRateComponent } from 'ng-zorro-antd/rate';
import { NzStatisticComponent } from 'ng-zorro-antd/statistic';
import { NzProgressComponent } from 'ng-zorro-antd/progress';
import { NzSpinComponent } from 'ng-zorro-antd/spin';
import { NzSkeletonComponent } from 'ng-zorro-antd/skeleton';
import { NzDividerComponent } from 'ng-zorro-antd/divider';
import { NzTabComponent, NzTabSetComponent } from 'ng-zorro-antd/tabs';
import { NzCollapseComponent, NzCollapsePanelComponent } from 'ng-zorro-antd/collapse';
import {
  NzTableCellDirective,
  NzTableComponent,
  NzTbodyComponent,
  NzThAddOnComponent,
  NzTheadComponent,
  NzThMeasureDirective,
  NzTrDirective,
} from 'ng-zorro-antd/table';
import { NzModalComponent, NzModalContentDirective, NzModalService } from 'ng-zorro-antd/modal';
import { NzCheckboxComponent } from 'ng-zorro-antd/checkbox';

@Component({
  selector: 'app-nz-playground',
  standalone: true,
  imports: [
    NzLayoutComponent,
    NzSiderComponent,
    NzMenuDirective,
    NzIconDirective,
    NzHeaderComponent,
    NzDropDownDirective,
    NzButtonComponent,
    NzWaveDirective,
    NzDropdownMenuComponent,
    NzMenuItemComponent,
    NzBadgeComponent,
    NzAvatarComponent,
    NzBreadCrumbComponent,
    NzContentComponent,
    NzBreadCrumbItemComponent,
    NzRowDirective,
    NzColDirective,
    NzCardComponent,
    NzTooltipDirective,
    NzSegmentedComponent,
    FormsModule,
    NzTagComponent,
    NzInputGroupComponent,
    NzInputDirective,
    NzSelectComponent,
    NzOptionComponent,
    NzAutocompleteTriggerDirective,
    NzAutocompleteComponent,
    NzAutocompleteOptionComponent,
    NzDatePickerComponent,
    NzTreeSelectComponent,
    NzSwitchComponent,
    NzRadioGroupComponent,
    NzRateComponent,
    NzStatisticComponent,
    NzProgressComponent,
    NzSpinComponent,
    NzSkeletonComponent,
    NzDividerComponent,
    NzTabSetComponent,
    NzTabComponent,
    NzCollapseComponent,
    NzCollapsePanelComponent,
    NzTableComponent,
    NzThAddOnComponent,
    NzTheadComponent, // table hidden directive
    NzTbodyComponent, // table hidden directive
    NzTrDirective, // table hidden directive
    NzTableCellDirective, // table hidden directive
    NzThMeasureDirective, // table hidden directive
    NzModalComponent,
    NzRadioComponent,
    NzCheckboxComponent,
    NzSubMenuComponent,
    NzModalContentDirective,
    NzDropdownButtonDirective,
  ],
  providers: [NzModalService],
  templateUrl: './nz-playground.component.html',
  styleUrl: './nz-playground.component.css',
})
export class NzPlaygroundComponent {
  readonly tableData = nzTableItems;
  readonly treeNodes = nzTreeNodes;
  readonly segmentedOptions = ['Smoke', 'Full', 'Parser'];

  searchValue = 'NG-ZORRO';
  selectedCity = 'Moscow';
  selectedMode = 'Parser';
  selectedDate = new Date('2026-03-14');
  selectedStatus = 'ready';
  selectedTreeNode = '0-1';
  checked = true;
  switched = true;
  radioValue = 'a';
  rateValue = 4;
  modalVisible = false;
  loading = false;
  progress = 76;

  readonly cityOptions = ['Moscow', 'Saint Petersburg', 'Kazan'];

  readonly sortByName = (a: NzTableItem, b: NzTableItem): number => a.name.localeCompare(b.name);
  readonly sortByTeam = (a: NzTableItem, b: NzTableItem): number => a.team.localeCompare(b.team);
  readonly sortByScore = (a: NzTableItem, b: NzTableItem): number => a.score - b.score;
}
