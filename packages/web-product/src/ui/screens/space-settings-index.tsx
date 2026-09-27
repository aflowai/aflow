import { redirect } from 'next/navigation';

interface SettingsIndexProps {
  params: Promise<{ space: string }>;
}

export async function SettingsIndex({ params }: SettingsIndexProps) {
  const { space } = await params;
  redirect(`/s/${encodeURIComponent(space)}/settings/general`);
}
