import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Paperclip, Mic, MapPin, FileImage, FileText, X, Loader2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface QuickMessage {
  id: string;
  title: string;
  content: string;
  messageType: string;
  isActive: boolean;
}

interface MessageInputProps {
  conversationId: string;
  disabled?: boolean;
  quickMessages?: QuickMessage[];
  agentId?: string;
}

export function MessageInput({ conversationId, disabled, quickMessages = [], agentId = "" }: MessageInputProps) {
  const [message, setMessage] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const { toast } = useToast();

  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      
      const response = await fetch('/api/messages/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Erro ao fazer upload do arquivo');
      }
      
      return response.json();
    },
    onSuccess: async (data) => {
      const messageType = selectedFile?.type.startsWith('image/') ? 'image' : 
                         selectedFile?.type.startsWith('audio/') ? 'audio' :
                         selectedFile?.type.startsWith('video/') ? 'video' : 'document';
      
      await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        senderId: agentId,
        senderType: "agent",
        content: message || selectedFile?.name || "Arquivo enviado",
        messageType,
        mediaUrl: data.file.url,
        mediaType: data.file.mimetype,
        mediaSize: data.file.size,
        mediaFilename: data.file.filename,
        isRead: true,
      });
      
      setMessage("");
      setSelectedFile(null);
      setFilePreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      
      toast({
        title: "Sucesso",
        description: "Arquivo enviado com sucesso",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro",
        description: error.message || "Não foi possível enviar o arquivo",
        variant: "destructive",
      });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      return apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        senderId: agentId,
        senderType: "agent",
        content,
        messageType: "text",
        isRead: true,
      });
    },
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
    onError: () => {
      toast({
        title: "Erro",
        description: "Não foi possível enviar a mensagem",
        variant: "destructive",
      });
    },
  });

  const sendLocationMutation = useMutation({
    mutationFn: async ({ latitude, longitude }: { latitude: number; longitude: number }) => {
      return apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        senderId: agentId,
        senderType: "agent",
        content: `Localização: ${latitude}, ${longitude}`,
        messageType: "location",
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        isRead: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      toast({
        title: "Sucesso",
        description: "Localização enviada com sucesso",
      });
    },
    onError: () => {
      toast({
        title: "Erro",
        description: "Não foi possível enviar a localização",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile) {
      uploadFileMutation.mutate(selectedFile);
    } else if (message.trim() && !disabled) {
      sendMessageMutation.mutate(message.trim());
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      
      // Create preview for images
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onloadend = () => {
          setFilePreview(reader.result as string);
        };
        reader.readAsDataURL(file);
      } else {
        setFilePreview(null);
      }
    }
  };

  const handleAudioSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setFilePreview(null);
    }
  };

  const clearSelectedFile = () => {
    setSelectedFile(null);
    setFilePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (audioInputRef.current) audioInputRef.current.value = '';
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/ogg' });
        const audioFile = new File([audioBlob], `audio-${Date.now()}.ogg`, { type: 'audio/ogg' });
        setSelectedFile(audioFile);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      toast({
        title: "Erro",
        description: "Não foi possível acessar o microfone",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const sendLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          sendLocationMutation.mutate({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        () => {
          toast({
            title: "Erro",
            description: "Não foi possível obter sua localização",
            variant: "destructive",
          });
        }
      );
    } else {
      toast({
        title: "Erro",
        description: "Geolocalização não é suportada neste navegador",
        variant: "destructive",
      });
    }
  };

  const insertQuickResponse = (response: string) => {
    setMessage(response);
  };

  return (
    <div className="bg-white border-t border-gray-200 p-4">
      <form onSubmit={handleSubmit} className="flex items-end space-x-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
          onChange={handleFileSelect}
          className="hidden"
          data-testid="input-file-upload"
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*"
          onChange={handleAudioSelect}
          className="hidden"
          data-testid="input-audio-upload"
        />
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button 
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              data-testid="button-attach-menu"
            >
              <Paperclip className="h-5 w-5 text-gray-500" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()} data-testid="button-attach-file">
              <FileImage className="mr-2 h-4 w-4" />
              <span>Imagem ou Documento</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => audioInputRef.current?.click()} data-testid="button-attach-audio-file">
              <FileText className="mr-2 h-4 w-4" />
              <span>Arquivo de Áudio</span>
            </DropdownMenuItem>
            <DropdownMenuItem 
              onClick={isRecording ? stopRecording : startRecording}
              data-testid="button-record-audio"
            >
              <Mic className={`mr-2 h-4 w-4 ${isRecording ? 'text-red-500' : ''}`} />
              <span>{isRecording ? 'Parar Gravação' : 'Gravar Áudio'}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={sendLocation} data-testid="button-send-location">
              <MapPin className="mr-2 h-4 w-4" />
              <span>Enviar Localização</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1">
          {/* File Preview */}
          {selectedFile && (
            <div className="mb-2 p-2 bg-gray-100 rounded-lg flex items-center justify-between">
              {filePreview ? (
                <img src={filePreview} alt="Preview" className="h-16 w-16 object-cover rounded" />
              ) : (
                <div className="flex items-center">
                  <FileText className="h-8 w-8 text-gray-500 mr-2" />
                  <span className="text-sm text-gray-700">{selectedFile.name}</span>
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={clearSelectedFile}
                data-testid="button-clear-file"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div className="relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={disabled ? "Conversa finalizada" : selectedFile ? "Adicione uma legenda (opcional)" : "Digite sua mensagem..."}
              className="w-full resize-none border border-gray-300 rounded-lg px-4 py-3 pr-12 focus:outline-none focus:ring-2 focus:ring-whatsapp-500 focus:border-transparent max-h-32 disabled:bg-gray-100 disabled:cursor-not-allowed"
              rows={1}
              disabled={disabled}
              data-testid="input-message"
              style={{
                minHeight: "44px",
                height: "44px",
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "44px";
                target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
              }}
            />
            <button
              type="button"
              className="absolute right-3 bottom-3 text-gray-400 hover:text-gray-600 transition-colors"
              disabled={disabled}
            >
              <i className="fas fa-smile text-xl"></i>
            </button>
          </div>
          {/* Quick Responses */}
          {!disabled && quickMessages.length > 0 && !selectedFile && (
            <div className="flex flex-wrap gap-2 mt-2">
              {quickMessages.map((quickMessage) => (
                <button
                  key={quickMessage.id}
                  type="button"
                  onClick={() => insertQuickResponse(quickMessage.content)}
                  className="px-3 py-1 text-sm bg-whatsapp-50 text-whatsapp-700 rounded-full hover:bg-whatsapp-100 transition-colors border border-whatsapp-200"
                  data-testid={`button-quick-message-${quickMessage.id}`}
                >
                  {quickMessage.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button
          type="submit"
          disabled={(!message.trim() && !selectedFile) || disabled || sendMessageMutation.isPending || uploadFileMutation.isPending}
          className="bg-whatsapp-500 hover:bg-whatsapp-600"
          data-testid="button-send-message"
        >
          {(sendMessageMutation.isPending || uploadFileMutation.isPending) ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <i className="fas fa-paper-plane"></i>
          )}
        </Button>
      </form>
    </div>
  );
}
