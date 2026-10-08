import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Auth, type AuthContext } from '../../auth/auth-context';
import { idParam } from '../../common/id-param';
import { NotificationsService } from '../services/notifications.service';

/** The signed-in user's own notifications (the studio's bell). */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.notifications.list(auth);
  }

  @Post('read')
  @HttpCode(200)
  readAll(@Auth() auth: AuthContext) {
    return this.notifications.markRead(auth);
  }

  @Post(':id/read')
  @HttpCode(200)
  readOne(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.notifications.markRead(auth, idParam(id));
  }
}
