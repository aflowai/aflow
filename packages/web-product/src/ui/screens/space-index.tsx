import { redirect } from 'next/navigation';

interface SpaceIndexProps {
  params: Promise<{ space: string }>;
}

export async function SpaceIndex({ params }: SpaceIndexProps) {
  const { space } = await params;
  redirect(`/s/${encodeURIComponent(space)}/chat`);
}
