// Hand-written NestJS controller case: the CLI has no NestJS pack,
// so these @Get / @Render methods are not framework-kept — they
// grade REVIEW (0 in-repo callers), even though the file sits under
// src/views/. The old web analyzer kept the whole file's symbols
// for sitting in a route directory. The unexported helper at the
// bottom is the planted SAFE control.
import { Controller, Get, Module, Param, Query, Render } from '@nestjs/common';

@Controller()
export class ViewsController {
  @Get('page')
  @Render('index')
  page() {
    return { message: 'Hello', year: 2026 };
  }

  @Get('section')
  @Render('section')
  section() {
    return { message: 'Hello' };
  }

  @Get('decode')
  @Render('decode')
  decode(@Query('next') next: string) {
    return { next };
  }

  @Get('pages/:name')
  @Render('index')
  named(@Param('name') name: string) {
    return { message: name, year: 2026 };
  }
}

function deadHelper() {
  return 1;
}

@Module({ controllers: [ViewsController] })
export class ViewsModule {}
