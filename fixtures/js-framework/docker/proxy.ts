import type { NextRequest } from 'next';

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};

export default function middleware(req: NextRequest) {
  return Response.next();
}
