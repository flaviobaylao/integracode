import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";

interface OmieInstance {
  id: string;
  name: string;
  displayName: string;
  tagColor: string;
  isActive: boolean;
  isDefault: boolean;
}

interface OmieInstanceBadgeProps {
  instanceId: string | null | undefined;
  size?: "sm" | "md";
}

export default function OmieInstanceBadge({ instanceId, size = "sm" }: OmieInstanceBadgeProps) {
  const { data: instances } = useQuery<OmieInstance[]>({
    queryKey: ["/api/omie/instances/public"],
    staleTime: 5 * 60 * 1000,
  });

  if (!instanceId || !instances) {
    return null;
  }

  const instance = instances.find(i => i.id === instanceId);
  
  if (!instance) {
    return null;
  }

  const sizeClasses = size === "sm" 
    ? "text-[10px] px-1.5 py-0.5" 
    : "text-xs px-2 py-1";

  return (
    <Badge
      variant="outline"
      className={`${sizeClasses} font-semibold border-0`}
      style={{
        backgroundColor: instance.tagColor + "20",
        color: instance.tagColor,
      }}
    >
      {instance.name}
    </Badge>
  );
}
