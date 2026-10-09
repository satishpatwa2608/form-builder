import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { idParam } from '../common/id-param';
import { FormReviewService } from './form-review.service';

/** Review before publish, and comments on a draft. Who may do what is decided per form, from its folder. */
@Controller('forms/:id')
export class FormReviewController {
  constructor(private readonly reviews: FormReviewService) {}

  @Get('review')
  get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.reviews.get(auth, idParam(id));
  }

  @Post('review/request')
  @HttpCode(200)
  request(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reviews.request(auth, idParam(id), body);
  }

  @Post('review/cancel')
  @HttpCode(200)
  cancel(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.reviews.cancel(auth, idParam(id));
  }

  @Post('review/approve')
  @HttpCode(200)
  approve(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reviews.decide(auth, idParam(id), 'APPROVED', body);
  }

  @Post('review/changes')
  @HttpCode(200)
  changes(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reviews.decide(auth, idParam(id), 'CHANGES_REQUESTED', body);
  }

  @Post('comments')
  @HttpCode(200)
  comment(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reviews.addComment(auth, idParam(id), body);
  }

  @Post('comments/:commentId/resolve')
  @HttpCode(200)
  resolve(@Auth() auth: AuthContext, @Param('id') id: string, @Param('commentId') commentId: string) {
    return this.reviews.resolveComment(auth, idParam(id), idParam(commentId), true);
  }

  @Post('comments/:commentId/reopen')
  @HttpCode(200)
  reopen(@Auth() auth: AuthContext, @Param('id') id: string, @Param('commentId') commentId: string) {
    return this.reviews.resolveComment(auth, idParam(id), idParam(commentId), false);
  }

  @Delete('comments/:commentId')
  remove(@Auth() auth: AuthContext, @Param('id') id: string, @Param('commentId') commentId: string) {
    return this.reviews.removeComment(auth, idParam(id), idParam(commentId));
  }
}
