import { Link } from "wouter";
import { Home } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function BackToDashboardButton() {
  return (
    <Link href="/">
      <Button variant="outline" size="sm" className="flex items-center gap-2" data-testid="button-back-dashboard">
        <Home className="w-4 h-4" />
        Voltar ao Dashboard
      </Button>
    </Link>
  );
}
