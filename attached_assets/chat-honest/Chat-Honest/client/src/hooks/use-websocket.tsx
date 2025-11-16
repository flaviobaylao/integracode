import { useEffect, useRef } from "react";
import { queryClient } from "@/lib/queryClient";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  console.log("🌐 useWebSocket hook initialized");

  const connect = () => {
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      console.log(`🔌 Attempting to connect WebSocket to: ${wsUrl}`);
      console.log(`   Protocol: ${protocol}, Host: ${window.location.host}`);
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        console.log("WebSocket connected");
        reconnectAttemptsRef.current = 0;
        
        // Send agent connection message
        wsRef.current?.send(JSON.stringify({
          type: "agent_connect",
          agentId: "agent-1", // This would come from auth context in a real app
        }));
      };

      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          switch (message.type) {
            case "new_conversation":
            case "conversation_assigned":
            case "conversation_transferred":
            case "conversation_status_update":
            case "conversation_update":
              // Invalidate conversations list
              queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
              queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
              break;
              
            case "new_message":
              // Invalidate specific conversation messages
              queryClient.invalidateQueries({ 
                queryKey: ["/api/conversations", message.conversationId] 
              });
              queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
              break;
              
            case "agent_status_update":
              // Invalidate agents list
              queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
              queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
              break;
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      };

      wsRef.current.onclose = () => {
        console.log("WebSocket disconnected");
        wsRef.current = null;
        
        // Attempt to reconnect with exponential backoff
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          const timeout = Math.pow(2, reconnectAttemptsRef.current) * 1000;
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect();
          }, timeout);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error("❌ WebSocket error:", error);
        console.error("WebSocket URL was:", wsRef.current?.url);
      };
    } catch (error) {
      console.error("Failed to create WebSocket connection:", error);
    }
  };

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      
      if (wsRef.current) {
        // Send disconnect message
        wsRef.current.send(JSON.stringify({
          type: "agent_disconnect",
        }));
        wsRef.current.close();
      }
    };
  }, []);

  return wsRef.current;
}
