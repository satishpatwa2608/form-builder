import type { FieldType } from '../../types';
import type { FieldComponent } from '../fields/types';
import { TextField } from '../fields/TextField';
import { TextAreaField } from '../fields/TextAreaField';
import { NumberField } from '../fields/NumberField';
import { SelectField } from '../fields/SelectField';
import { RadioField } from '../fields/RadioField';
import { CheckboxField } from '../fields/CheckboxField';
import { ButtonField, ContentField, HiddenField, ImageField } from '../fields/SimpleFields';
import { CheckboxGroupField, ConsentField, StepperField, SwitchField } from '../fields/ChoiceFields';
import { SignatureField } from '../fields/SignatureField';
import { CustomField } from '../fields/CustomField';
import { RepeatField } from '../fields/RepeatField';
import { MultiSelectField } from '../fields/MultiSelectField';
import { FileField } from '../fields/FileField';
import { CaptchaField } from '../fields/CaptchaField';
import { AccordionField, ColumnsField, SectionField, TabsField } from '../fields/ContainerFields';

/**
 * FieldType -> component. A map rather than a switch so a new type is one
 * `registerFieldComponent` call, with no change to FieldRenderer or
 * FormContainer. Types missing here render UnsupportedField.
 */
const registry: Partial<Record<FieldType, FieldComponent>> = {
  TEXT: TextField,
  EMAIL: TextField,
  PHONE: TextField,
  DATE: TextField,
  DATETIME: TextField,
  TEXTAREA: TextAreaField,
  NUMBER: NumberField,
  DROPDOWN: SelectField,
  RADIO: RadioField,
  CHECKBOX: CheckboxField,
  HIDDEN: HiddenField,
  BUTTON: ButtonField,
  MULTI_SELECT: MultiSelectField,
  FILE: FileField,
  HTML: ContentField,
  CAPTCHA: CaptchaField,
  SWITCH: SwitchField,
  CHECKBOX_GROUP: CheckboxGroupField,
  STEPPER: StepperField,
  CONSENT: ConsentField,
  SIGNATURE: SignatureField,
  CUSTOM: CustomField,
  IMAGE: ImageField,
  COLUMNS: ColumnsField,
  SECTION: SectionField,
  TABS: TabsField,
  ACCORDION: AccordionField,
  REPEAT: RepeatField,
};

export function getFieldComponent(type: FieldType): FieldComponent | undefined {
  return registry[type];
}

export function registerFieldComponent(type: FieldType, component: FieldComponent): void {
  registry[type] = component;
}
