import React, { useRef, useState, useCallback } from "react";
// @ts-ignore
import Cropper from 'react-easy-crop';
import { Eye, Trash2 } from "lucide-react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

interface FileUploaderProps {
  allowedFileTypes?: string[];
  maxSizeMB?: number;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
  onFileUpload?(file: File | File[] | null): void;
  buttonText?: string;
  multiple?: boolean;
  customStyles?: React.CSSProperties;
  maxCount?: number;
  showPreview?: boolean;
  defaultFileList?: File[];
  showCrop?: boolean;
  cropAspectRatio?: number;
  cropShape?: 'rect' | 'round';
  isDragger?: boolean;
  /** Shorter dropzone, smaller filenames, 2-up grid with icon-only
   * preview/remove buttons instead of full text buttons. Opt-in and
   * defaulted off so every existing caller keeps its current look. */
  compact?: boolean;
}

export const FileUploader: React.FC<FileUploaderProps> = ({
  allowedFileTypes = ["image/*", "application/pdf"],
  maxSizeMB = 5,
  onFileUpload,
  buttonText = "Upload File",
  multiple = false,
  customStyles = {},
  maxCount,
  showPreview = true,
  defaultFileList = [],
  showCrop = false,
  cropAspectRatio = 1,
  cropShape = 'rect',
  isDragger = false,
  compact = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileList, setFileList] = useState<File[]>(Array.isArray(defaultFileList) ? defaultFileList : []);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  // Cropper state
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [cropImage, setCropImage] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);
  const hasReachedFileLimit = !multiple && fileList.length >= 1;

  const resetInputValue = () => {
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const validateFileSize = (file: File) => {
    const size = file.size / 1024 / 1024;
    if (size > maxSizeMB) {
      alert(`File exceeds ${maxSizeMB}MB limit`);
      return false;
    }
    return true;
  };

  const isAllowedType = (file: File) => {
    return allowedFileTypes.some((type) => {
      if (type.includes("*")) return file.type.startsWith(type.split("/")[0]);
      return file.type === type || file.name.endsWith(type);
    });
  };

  const handleInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (hasReachedFileLimit) return;
    let files = Array.from(e.target.files || []);
    if (!multiple) files = files.slice(0, 1);
    if (maxCount) files = files.slice(0, maxCount);
    const validFiles = files.filter((file) => validateFileSize(file) && isAllowedType(file));
    if (showCrop && validFiles.length && validFiles[0].type.startsWith('image/')) {
      // Only crop first image for now
      const reader = new FileReader();
      reader.onload = () => {
        setCropImage(reader.result as string);
        setCropFile(validFiles[0]);
        setCropModalOpen(true);
      };
      reader.readAsDataURL(validFiles[0]);
      return;
    }
    setFileList(validFiles);
    onFileUpload?.(multiple ? validFiles : validFiles[0] || null);
    resetInputValue();
  };
  // Cropper logic
  const onCropComplete = useCallback((_: unknown, croppedAreaPixels: unknown) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const getCroppedImg = (imageSrc: string, cropPixels: any, fileType: string): Promise<File> => {
    return new Promise((resolve, reject) => {
      const image = new window.Image();
      image.src = imageSrc;
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = cropPixels.width;
        canvas.height = cropPixels.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject();
        ctx.drawImage(
          image,
          cropPixels.x,
          cropPixels.y,
          cropPixels.width,
          cropPixels.height,
          0,
          0,
          cropPixels.width,
          cropPixels.height
        );
        canvas.toBlob((blob) => {
          if (!blob) return reject();
          const croppedFile = new File([blob], cropFile?.name || 'cropped.png', { type: fileType });
          resolve(croppedFile);
        }, fileType);
      };
      image.onerror = reject;
    });
  };

  const handleCropDone = async () => {
    if (!cropImage || !croppedAreaPixels || !cropFile) return;
    const cropped = await getCroppedImg(cropImage, croppedAreaPixels, cropFile.type);
    setFileList([cropped]);
    onFileUpload?.(cropped);
    resetInputValue();
    setCropModalOpen(false);
    setCropImage(null);
    setCropFile(null);
  };

  const handleRemove = (file: File) => {
    const updated = fileList.filter((f) => f !== file);
    setFileList(updated);
    onFileUpload?.(multiple ? updated : null);
    resetInputValue();
  };

  const handlePreview = async (file: File) => {
    if (!showPreview) return;
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => setPreviewFile(reader.result as string);
      reader.readAsDataURL(file);
      setPreviewOpen(true);
    }
  };

  // Drag-and-drop logic
  const [dragActive, setDragActive] = useState(false);
  const handleDrag = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (hasReachedFileLimit) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const event = { target: { files: e.dataTransfer.files } } as any;
      handleInputChange(event);
    }
  };

  const uploadUI = hasReachedFileLimit ? null : isDragger ? (
    <div
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded text-center transition-colors cursor-pointer ${compact ? 'p-3' : 'p-6'} ${dragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
      style={customStyles}
      onClick={() => {
        inputRef.current?.click();
      }}
    >
      <div className={`flex flex-col items-center justify-center ${compact ? 'gap-0.5' : 'gap-2'}`}>
        {/* <span style={{ fontSize: 32 }}>📁</span> */}
        <span className={compact ? 'text-xs font-medium' : undefined}>{buttonText}</span>
        <span className={`text-muted-foreground ${compact ? 'text-[10px]' : 'text-xs'}`}>Drag & drop files here or click to select</span>
      </div>
    </div>
  ) : (
    <Button onClick={() => inputRef.current?.click()}>{buttonText}</Button>
  );

  return (
    <div style={customStyles}>
      <input
        ref={inputRef}
        type="file"
        style={{ display: "none" }}
        accept={allowedFileTypes.join(",")}
        multiple={multiple}
        onChange={handleInputChange}
      />
      {uploadUI}
      <div className={compact ? "grid grid-cols-2 gap-2 mt-2" : "flex flex-wrap gap-2 mt-2"}>
        {Array.isArray(fileList) && fileList.map((file, idx) =>
          compact ? (
            <div
              key={idx}
              className="flex items-center gap-1 border rounded p-1.5 bg-card min-w-0"
            >
              <span className="truncate flex-1 text-xs" title={file.name}>
                {file.name}
              </span>
              {showPreview && file.type.startsWith("image/") && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => handlePreview(file)}
                  title="Preview"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                onClick={() => handleRemove(file)}
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div key={idx} className="flex items-center gap-2 border rounded p-2 bg-card">
              <span className="truncate max-w-xs">{file.name}</span>
              {showPreview && file.type.startsWith("image/") && (
                <Button variant="ghost" size="sm" onClick={() => handlePreview(file)}>
                  Preview
                </Button>
              )}
              <Button variant="destructive" size="sm" onClick={() => handleRemove(file)}>
                Remove
              </Button>
            </div>
          ),
        )}
      </div>
      {/* Image Cropper Dialog */}
      <Dialog open={cropModalOpen} onOpenChange={setCropModalOpen}>
        <DialogContent>
          <DialogTitle>Crop Image</DialogTitle>
          {cropImage && (
            <div className="relative w-full h-80 bg-muted">
              <Cropper
                image={cropImage}
                crop={crop}
                zoom={zoom}
                aspect={cropAspectRatio}
                cropShape={cropShape}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
          )}
          <div className="flex gap-2 mt-4">
            <Button onClick={handleCropDone}>Crop & Upload</Button>
            <Button variant="outline" onClick={() => setCropModalOpen(false)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogTitle>Preview</DialogTitle>
          {previewFile && <img src={previewFile} alt="Preview" className="max-w-full max-h-[60vh] mx-auto" />}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default FileUploader;
