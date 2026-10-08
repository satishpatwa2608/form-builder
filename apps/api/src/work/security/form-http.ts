import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * A validation failure the form UI can show next to each field. The shared
 * global filter only keeps `message` (and `details` in development), so this
 * module handles its own field errors with a controller-scoped filter instead
 * of changing the shared one.
 */
export class FormFieldErrors extends HttpException {
  constructor(
    status: 400 | 422,
    message: string,
    readonly errors: FieldError[],
  ) {
    super({ message, errors }, status);
  }
}

@Catch(FormFieldErrors)
export class FormFieldErrorsFilter implements ExceptionFilter {
  catch(exception: FormFieldErrors, host: ArgumentsHost) {
    const status = exception.getStatus();
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ message: exception.message, errors: exception.errors.slice(0, 50) });
  }
}
