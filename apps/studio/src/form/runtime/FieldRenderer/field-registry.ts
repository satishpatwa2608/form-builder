import type { FieldType } from '../../types';
import type { FieldComponent } from '../fields/types';
import { TextField } from '../fields/TextField';
import { TextAreaField } from '../fields/TextAreaField';
import { NumberField } from '../fields/NumberField';
import { SelectField } from '../fields/SelectField';
import { RadioField } from '../fields/RadioField';
import { CheckboxField } from '../fields/CheckboxField';
import { ButtonField, ContentField, HiddenField } from '../fields/SimpleFields';
import { MultiSelectField } from '../fields/MultiSelectField';
import { FileField } from '../fields/FileField';
import { CaptchaField } from '../fields/CaptchaField';
import { ColumnsField, SectionField } from '../fields/ContainerFields';

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
  COLUMNS: ColumnsField,
  SECTION: SectionField,
};

export function getFieldComponent(type: FieldType): FieldComponent | undefined {
  return registry[type];
}

export function registerFieldComponent(type: FieldType, component: FieldComponent): void {
  registry[type] = component;
}
