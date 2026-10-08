export interface SelectOption {
  label: string;
  value: string;
}

export interface ApiDataSource {
  url: string;
  method: 'GET' | 'POST';
  /** Property of each response row used as the option value. */
  valueField: string;
  /** Property of each response row used as the option label. */
  labelField: string;
  /**
   * Request params. Values may reference other fields as `{{fieldName}}` or
   * system context as `{{$system.BUSINESS_ID}}`. While any reference is
   * unresolved the request is not made.
   */
  params?: Record<string, string>;
}

export interface DataSourceConfig {
  type: 'STATIC' | 'API';
  options?: SelectOption[];
  api?: ApiDataSource;
}
