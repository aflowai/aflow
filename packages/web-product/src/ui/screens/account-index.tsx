import { redirect } from 'next/navigation';

export function AccountIndexPage() {
  redirect('/account/profile');
}
