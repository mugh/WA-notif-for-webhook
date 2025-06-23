// WhatsApp Webhook Manager Frontend JS

document.addEventListener('DOMContentLoaded', function() {
  // Initialize emoji picker
  initEmojiPicker();
  
  // Initialize tooltips if Bootstrap is available
  if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
      return new bootstrap.Tooltip(tooltipTriggerEl);
    });
  }

  // Initialize toast container
  initToastContainer();
  
  // Create modal on page load
  createDeleteModal();
  
  // Check for flash messages and display as toasts
  const flashMessageElement = document.getElementById('flash-message-data');
  if (flashMessageElement) {
    try {
      const flashMessage = JSON.parse(flashMessageElement.textContent);
      if (flashMessage && flashMessage.text) {
        showToast(flashMessage.text, flashMessage.type || 'info');
      }
    } catch (error) {
      console.error('Error parsing flash message:', error);
    }
  }

  // Handle test webhook button for template variables
  const testWebhookBtn = document.getElementById('test-webhook-btn');
  if (testWebhookBtn) {
    testWebhookBtn.addEventListener('click', function() {
      // Check if we have a webhook ID (only available in edit mode)
      const webhookIdMatch = window.location.pathname.match(/\/webhooks\/([^\/]+)/);
      if (webhookIdMatch && webhookIdMatch[1]) {
        const webhookId = webhookIdMatch[1];
        sendTestWebhook(webhookId);
      } else {
        showToast('Please save the webhook first before testing', 'warning');
      }
    });
  }
  
  // Handle formatting buttons for WhatsApp
  const formatButtons = document.querySelectorAll('.format-btn');
  if (formatButtons.length > 0) {
    formatButtons.forEach(button => {
      button.addEventListener('click', function() {
        const format = this.getAttribute('data-format');
        const textarea = document.getElementById('custom_template');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = textarea.value.substring(start, end);
        
        if (selectedText.length === 0) {
          return; // Don't apply formatting if no text is selected
        }
        
        let formattedText = '';
        
        // Apply the appropriate WhatsApp formatting based on format type
        switch (format) {
          case 'bold':
            formattedText = `*${selectedText}*`;
            break;
          case 'italic':
            formattedText = `_${selectedText}_`;
            break;
          case 'strikethrough':
            formattedText = `~${selectedText}~`;
            break;
          case 'monospace':
            formattedText = `\`\`\`${selectedText}\`\`\``;
            break;
          case 'inline-code':
            formattedText = `\`${selectedText}\``;
            break;
          case 'bullet-list':
            // Split by lines and add bullet points
            formattedText = selectedText.split('\n').map(line => {
              return line.trim() ? `* ${line.trim()}` : line;
            }).join('\n');
            break;
          case 'numbered-list':
            // Split by lines and add numbers
            formattedText = selectedText.split('\n').map((line, index) => {
              return line.trim() ? `${index + 1}. ${line.trim()}` : line;
            }).join('\n');
            break;
          case 'quote':
            // Split by lines and add quote markers
            formattedText = selectedText.split('\n').map(line => {
              return line.trim() ? `> ${line.trim()}` : line;
            }).join('\n');
            break;
          default:
            formattedText = selectedText;
        }
        
        // Replace the selected text with formatted text
        textarea.value = textarea.value.substring(0, start) + formattedText + textarea.value.substring(end);
        
        // Set cursor position after the formatted text
        textarea.focus();
        const newCursorPos = start + formattedText.length;
        textarea.selectionStart = newCursorPos;
        textarea.selectionEnd = newCursorPos;
      });
    });
  }
  
  // Handle emoji buttons
  const emojiButtons = document.querySelectorAll('.emoji-btn');
  if (emojiButtons.length > 0) {
    emojiButtons.forEach(button => {
      button.addEventListener('click', function() {
        const emoji = this.getAttribute('data-emoji');
        if (emoji) {
          insertTextAtCursor(emoji);
          
          // Close emoji picker modal if it exists
          const emojiPickerModal = document.getElementById('emoji-picker-modal');
          if (emojiPickerModal) {
            emojiPickerModal.classList.add('hidden');
          }
        }
      });
    });
  }

  // Handle send test webhook button
  const sendTestWebhookBtn = document.getElementById('send-test-webhook-btn');
  if (sendTestWebhookBtn) {
    sendTestWebhookBtn.addEventListener('click', function() {
      const webhookId = this.getAttribute('data-webhook-id');
      if (webhookId) {
        sendWebhookTest(webhookId);
      } else {
        showToast('Webhook ID tidak ditemukan', 'warning');
      }
    });
  }

  // Initialize drag and drop for variables
  initDragAndDrop();

  // Handle QR code refresh
  const refreshQRButtons = document.querySelectorAll('.refresh-qr');
  if (refreshQRButtons) {
    refreshQRButtons.forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        const instanceId = this.dataset.instance;
        refreshQRCode(instanceId);
      });
    });
  }

  // Handle instance status refresh
  const refreshStatusButtons = document.querySelectorAll('.refresh-status');
  if (refreshStatusButtons) {
    refreshStatusButtons.forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        const instanceId = this.dataset.instance;
        refreshStatus(instanceId);
      });
    });
  }

  // Handle instance deletion
  const deleteButtons = document.querySelectorAll('.delete-instance');
  if (deleteButtons) {
    deleteButtons.forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        const instanceId = this.dataset.instance;
        const instanceName = this.dataset.name || 'this WhatsApp instance';
        
        showConfirmModal(
          `Are you sure you want to delete the WhatsApp instance "${instanceName}"?`,
          function() {
            deleteInstance(instanceId);
          }
        );
      });
    });
  }

  // Handle add instance form submission
  const addInstanceForm = document.getElementById('add-instance-form');
  if (addInstanceForm) {
    addInstanceForm.addEventListener('submit', function(e) {
      e.preventDefault();
      
      const instanceName = document.getElementById('instance-name').value;
      const recipientNumber = document.getElementById('recipient-number').value;
      const webhookPath = document.getElementById('webhook-path').value;
      
      addInstance(instanceName, recipientNumber, webhookPath);
    });
  }

  // Toggle custom template section based on format type
  const formatTypeSelect = document.getElementById('format_type');
  const customTemplateSection = document.getElementById('custom-template-section');

  if (formatTypeSelect && customTemplateSection) {
    formatTypeSelect.addEventListener('change', function() {
      if (this.value === 'custom') {
        customTemplateSection.classList.remove('hidden');
      } else {
        customTemplateSection.classList.add('hidden');
      }
    });
  }

  // Emoji picker functionality for webhook form
  const emojiPickerBtn = document.getElementById('emoji-picker-btn');
  const emojiPickerModal = document.getElementById('emoji-picker-modal');
  
  if (emojiPickerBtn && emojiPickerModal) {
    // Open modal when emoji button is clicked
    emojiPickerBtn.addEventListener('click', function() {
      emojiPickerModal.classList.remove('hidden');
    });
    
    // Close modal when close button is clicked
    const closeButtons = emojiPickerModal.querySelectorAll('.emoji-modal-close');
    closeButtons.forEach(button => {
      button.addEventListener('click', function() {
        emojiPickerModal.classList.add('hidden');
      });
    });
    
    // Close modal when clicking outside of it
    emojiPickerModal.addEventListener('click', function(e) {
      if (e.target === emojiPickerModal) {
        emojiPickerModal.classList.add('hidden');
      }
    });
    
    // Close modal with Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !emojiPickerModal.classList.contains('hidden')) {
        emojiPickerModal.classList.add('hidden');
      }
    });
    
    // Handle emoji category switching
    const categoryButtons = document.querySelectorAll('.emoji-category-btn');
    categoryButtons.forEach(button => {
      button.addEventListener('click', function() {
        // Update active category button
        categoryButtons.forEach(btn => {
          btn.classList.remove('bg-blue-100', 'text-blue-800');
          btn.classList.add('bg-gray-100', 'text-gray-800');
        });
        this.classList.remove('bg-gray-100', 'text-gray-800');
        this.classList.add('bg-blue-100', 'text-blue-800');
        
        // Show the selected category grid and hide others
        const category = this.getAttribute('data-category');
        const emojiGrids = document.querySelectorAll('.emoji-grid');
        emojiGrids.forEach(grid => {
          grid.classList.add('hidden');
        });
        
        const selectedGrid = document.getElementById(`emoji-grid-${category}`);
        if (selectedGrid) {
          selectedGrid.classList.remove('hidden');
        }
      });
    });
    
    // Handle emoji search
    const emojiSearch = document.getElementById('emoji-search');
    if (emojiSearch) {
      emojiSearch.addEventListener('input', function() {
        const searchTerm = this.value.toLowerCase();
        
        if (searchTerm.length === 0) {
          // If search is empty, reset to category view
          const activeCategory = document.querySelector('.emoji-category-btn.bg-blue-100');
          if (activeCategory) {
            const category = activeCategory.getAttribute('data-category');
            const emojiGrids = document.querySelectorAll('.emoji-grid');
            emojiGrids.forEach(grid => {
              grid.classList.add('hidden');
            });
            
            const selectedGrid = document.getElementById(`emoji-grid-${category}`);
            if (selectedGrid) {
              selectedGrid.classList.remove('hidden');
            }
          }
        } else {
          // Show all emoji grids for searching
          const emojiGrids = document.querySelectorAll('.emoji-grid');
          emojiGrids.forEach(grid => {
            grid.classList.remove('hidden');
          });
          
          // Filter emojis based on search
          const emojiButtons = document.querySelectorAll('.emoji-btn');
          emojiButtons.forEach(button => {
            const emoji = button.textContent;
            const emojiData = button.getAttribute('data-emoji');
            
            // Simple search - just check if emoji contains the search term
            if (emoji.toLowerCase().includes(searchTerm) || 
                (button.getAttribute('data-keywords') && 
                 button.getAttribute('data-keywords').toLowerCase().includes(searchTerm))) {
              button.style.display = '';
            } else {
              button.style.display = 'none';
            }
          });
        }
      });
    }
  }

  // Handle publish checkbox highlight
  const publishCheckbox = document.getElementById('is_published');
  const publishContainer = document.querySelector('.publish-highlight');
  
  if (publishCheckbox && publishContainer) {
    // If checkbox is already checked, remove highlight
    if (publishCheckbox.checked) {
      publishContainer.classList.remove('publish-highlight');
    }
    
    // Remove highlight when checkbox is checked
    publishCheckbox.addEventListener('change', function() {
      if (this.checked) {
        publishContainer.classList.remove('publish-highlight');
      } else {
        publishContainer.classList.add('publish-highlight');
      }
    });
  }

  // Font color dropdown functionality
  const fontColorBtn = document.getElementById('font-color-btn');
  const fontColorDropdown = document.getElementById('font-color-dropdown');
  
  if (fontColorBtn && fontColorDropdown) {
    // Position the dropdown relative to the button
    fontColorBtn.addEventListener('click', function() {
      const buttonRect = fontColorBtn.getBoundingClientRect();
      fontColorDropdown.style.top = (buttonRect.bottom + window.scrollY) + 'px';
      fontColorDropdown.style.left = (buttonRect.left + window.scrollX) + 'px';
      
      fontColorDropdown.classList.toggle('hidden');
      
      // Hide the font size dropdown if it's open
      if (fontSizeDropdown && !fontSizeDropdown.classList.contains('hidden')) {
        fontSizeDropdown.classList.add('hidden');
      }
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!fontColorBtn.contains(e.target) && !fontColorDropdown.contains(e.target)) {
        fontColorDropdown.classList.add('hidden');
      }
    });
    
    // Handle color selection
    const colorButtons = document.querySelectorAll('.color-btn');
    colorButtons.forEach(button => {
      button.addEventListener('click', function() {
        const color = this.getAttribute('data-color');
        const textarea = document.getElementById('custom_template');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = textarea.value.substring(start, end);
        
        // WhatsApp doesn't support color, so we'll use a custom format
        // that can be processed by the webhook handler
        const replacement = `[color=${color}]${selectedText}[/color]`;
        
        textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
        textarea.focus();
        textarea.selectionStart = start + `[color=${color}]`.length;
        textarea.selectionEnd = start + `[color=${color}]`.length + selectedText.length;
        
        // Close the dropdown
        fontColorDropdown.classList.add('hidden');
      });
    });
  }
  
  // Font size dropdown functionality
  const fontSizeBtn = document.getElementById('font-size-btn');
  const fontSizeDropdown = document.getElementById('font-size-dropdown');
  
  if (fontSizeBtn && fontSizeDropdown) {
    // Position the dropdown relative to the button
    fontSizeBtn.addEventListener('click', function() {
      const buttonRect = fontSizeBtn.getBoundingClientRect();
      fontSizeDropdown.style.top = (buttonRect.bottom + window.scrollY) + 'px';
      fontSizeDropdown.style.left = (buttonRect.left + window.scrollX) + 'px';
      
      fontSizeDropdown.classList.toggle('hidden');
      
      // Hide the font color dropdown if it's open
      if (fontColorDropdown && !fontColorDropdown.classList.contains('hidden')) {
        fontColorDropdown.classList.add('hidden');
      }
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!fontSizeBtn.contains(e.target) && !fontSizeDropdown.contains(e.target)) {
        fontSizeDropdown.classList.add('hidden');
      }
    });
    
    // Handle size selection
    const sizeButtons = document.querySelectorAll('.size-btn');
    sizeButtons.forEach(button => {
      button.addEventListener('click', function() {
        const size = this.getAttribute('data-size');
        const textarea = document.getElementById('custom_template');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = textarea.value.substring(start, end);
        
        // WhatsApp doesn't support font size, so we'll use a custom format
        // that can be processed by the webhook handler
        const replacement = `[size=${size}]${selectedText}[/size]`;
        
        textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
        textarea.focus();
        textarea.selectionStart = start + `[size=${size}]`.length;
        textarea.selectionEnd = start + `[size=${size}]`.length + selectedText.length;
        
        // Close the dropdown
        fontSizeDropdown.classList.add('hidden');
      });
    });
  }
});

// Toast notification functions
function initToastContainer() {
  // Create toast container if it doesn't exist
  if (!document.querySelector('.toast-container')) {
    const toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

function showToast(message, type = 'info', duration = 5000) {
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  // Create toast content
  const toastContent = document.createElement('div');
  toastContent.className = 'toast-content';
  toastContent.textContent = message;
  
  // Create close button
  const closeButton = document.createElement('button');
  closeButton.className = 'toast-close';
  closeButton.innerHTML = '&times;';
  closeButton.addEventListener('click', () => {
    removeToast(toast);
  });
  
  // Create progress bar
  const progressContainer = document.createElement('div');
  progressContainer.className = 'toast-progress';
  
  const progressBar = document.createElement('div');
  progressBar.className = 'toast-progress-bar';
  progressBar.style.animation = `progress-bar-animation ${duration}ms linear forwards`;
  progressContainer.appendChild(progressBar);
  
  // Append elements to toast
  toast.appendChild(toastContent);
  toast.appendChild(closeButton);
  toast.appendChild(progressContainer);
  
  // Add toast to container
  const container = document.querySelector('.toast-container');
  container.appendChild(toast);
  
  // Remove toast after duration
  setTimeout(() => {
    removeToast(toast);
  }, duration);
  
  return toast;
}

function removeToast(toast) {
  if (!toast) return;
  
  toast.classList.add('toast-out');
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 300); // Match the animation duration
}

// Modal functions
function createDeleteModal() {
  // Check if modal already exists
  if (document.getElementById('deleteConfirmModal')) {
    return;
  }
  
  const modal = document.createElement('div');
  modal.id = 'deleteConfirmModal';
  modal.className = 'fixed inset-0 z-50 hidden overflow-auto bg-black bg-opacity-50 flex items-center justify-center';
  
  modal.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl max-w-md mx-auto p-6 w-full">
      <div class="flex justify-between items-center border-b border-gray-200 pb-3 mb-4">
        <h5 class="text-lg font-bold text-gray-800" id="deleteConfirmModalLabel">Confirm Delete</h5>
        <button type="button" class="text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300 rounded-full p-1 modal-close">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>
      <div class="py-4">
        <p class="text-gray-600" id="deleteConfirmMessage">Are you sure you want to delete this item?</p>
      </div>
      <div class="flex justify-end pt-3 border-t border-gray-200 mt-4">
        <button type="button" class="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded transition-colors mr-3 modal-close">Cancel</button>
        <button type="button" class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded transition-colors" id="confirmDeleteBtn">Delete</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Add event listeners for modal
  const closeButtons = modal.querySelectorAll('.modal-close');
  closeButtons.forEach(button => {
    button.addEventListener('click', () => closeDeleteModal());
  });
  
  // Close modal when clicking on backdrop
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      closeDeleteModal();
    }
  });
}

function openDeleteModal(message, callback) {
  const modal = document.getElementById('deleteConfirmModal');
  if (!modal) {
    createDeleteModal();
  }
  
  const messageEl = document.getElementById('deleteConfirmMessage');
  if (messageEl) {
    messageEl.textContent = message;
  }
  
  // Set confirm button action
  const confirmBtn = document.getElementById('confirmDeleteBtn');
  if (confirmBtn) {
    // Remove existing event listeners
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    // Add new event listener
    newConfirmBtn.addEventListener('click', () => {
      closeDeleteModal();
      callback();
    });
  }
  
  // Show modal
  const modalElement = document.getElementById('deleteConfirmModal');
  if (modalElement) {
    modalElement.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function closeDeleteModal() {
  const modal = document.getElementById('deleteConfirmModal');
  if (!modal) return;
  
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

// Global function to show confirmation modal
window.showConfirmModal = function(message, callback) {
  openDeleteModal(message, callback);
};

// Function to handle API responses with toast notifications
function handleApiResponse(response, successCallback, errorCallback = null) {
  if (response.toast) {
    showToast(response.toast.text, response.toast.type || 'info');
  }
  
  if (response.success) {
    if (successCallback) {
      successCallback(response);
    }
  } else {
    if (errorCallback) {
      errorCallback(response);
    }
  }
}

// Function to refresh QR code
function refreshQRCode(instanceId) {
  const qrContainer = document.querySelector(`.qr-container[data-instance="${instanceId}"]`);
  if (qrContainer) {
    qrContainer.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div><p>Generating QR code...</p></div>';
    
    fetch(`/api/instance/${instanceId}/qr`, {
      method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
      handleApiResponse(data, 
        () => {
          // Success callback
          window.location.href = `/instance/${instanceId}/qr`;
        },
        () => {
          // Error callback
          qrContainer.innerHTML = `<div class="alert alert-danger">${data.message}</div>`;
        }
      );
    })
    .catch(error => {
      qrContainer.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
    });
  }
}

// Function to refresh instance status
function refreshStatus(instanceId) {
  const statusElement = document.querySelector(`.instance-status[data-instance="${instanceId}"]`);
  if (statusElement) {
    const originalText = statusElement.innerHTML;
    statusElement.innerHTML = 'Checking...';
    
    fetch(`/api/instance/${instanceId}/status`)
    .then(response => response.json())
    .then(data => {
      handleApiResponse(data,
        () => {
          // Success callback
          statusElement.innerHTML = data.status;
          statusElement.className = `instance-status status-${data.status.toLowerCase()}`;
        },
        () => {
          // Error callback
          statusElement.innerHTML = originalText;
        }
      );
    })
    .catch(error => {
      statusElement.innerHTML = originalText;
      showToast(`Error: ${error.message}`, 'danger');
    });
  }
}

// Function to delete an instance
function deleteInstance(instanceId) {
  fetch(`/api/instance/${instanceId}`, {
    method: 'DELETE'
  })
  .then(response => response.json())
  .then(data => {
    handleApiResponse(data,
      () => {
        // Success callback
        const instanceElement = document.querySelector(`.instance-item[data-instance="${instanceId}"]`);
        if (instanceElement) {
          instanceElement.remove();
        } else {
          window.location.reload();
        }
      }
    );
  })
  .catch(error => {
    showToast(`Error: ${error.message}`, 'danger');
  });
}

// Function to add a new instance
function addInstance(name, recipientNumber, webhookPath) {
  fetch('/api/instance', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      recipientNumber,
      webhookPath
    })
  })
  .then(response => response.json())
  .then(data => {
    handleApiResponse(data,
      () => {
        // Success callback
        window.location.href = '/instances';
      },
      () => {
        // Error callback
        const errorElement = document.getElementById('add-instance-error');
        if (errorElement) {
          errorElement.textContent = data.message;
          errorElement.style.display = 'block';
        }
      }
    );
  })
  .catch(error => {
    showToast(`Error: ${error.message}`, 'danger');
  });
}

// Add event listeners for delete buttons (webhooks, recipients, plans)
document.addEventListener('DOMContentLoaded', function() {
  // Delete webhook buttons
  document.querySelectorAll('.delete-webhook').forEach(button => {
    button.addEventListener('click', function(e) {
      e.preventDefault();
      const webhookId = this.getAttribute('data-id');
      const webhookName = this.getAttribute('data-name') || 'this webhook';
      
      showConfirmModal(`Are you sure you want to delete ${webhookName}? This action cannot be undone.`, () => {
        deleteWebhook(webhookId);
      });
    });
  });
  
  // Delete recipient buttons
  document.querySelectorAll('.delete-recipient').forEach(button => {
    button.addEventListener('click', function(e) {
      e.preventDefault();
      const recipientId = this.getAttribute('data-id');
      const recipientName = this.getAttribute('data-name') || 'this recipient';
      
      showConfirmModal(`Are you sure you want to delete ${recipientName}? This action cannot be undone.`, () => {
        deleteRecipient(recipientId);
      });
    });
  });
  
  // Delete plan buttons
  document.querySelectorAll('.delete-plan').forEach(button => {
    button.addEventListener('click', function(e) {
      e.preventDefault();
      const planId = this.getAttribute('data-id');
      const planName = this.getAttribute('data-name') || 'this subscription plan';
      
      showConfirmModal(`Are you sure you want to delete ${planName}? This action cannot be undone.`, () => {
        deletePlan(planId);
      });
    });
  });
});

// Function to delete a webhook
function deleteWebhook(webhookId) {
  fetch(`/api/webhooks/${webhookId}`, {
    method: 'DELETE'
  })
  .then(response => response.json())
  .then(data => {
    handleApiResponse(data,
      () => {
        // Success callback
        const webhookElement = document.querySelector(`.webhook-item[data-id="${webhookId}"]`);
        if (webhookElement) {
          webhookElement.remove();
        } else {
          window.location.reload();
        }
      }
    );
  })
  .catch(error => {
    showToast(`Error: ${error.message}`, 'danger');
  });
}

// Function to delete a recipient
function deleteRecipient(recipientId) {
  fetch(`/api/recipients/${recipientId}`, {
    method: 'DELETE'
  })
  .then(response => response.json())
  .then(data => {
    handleApiResponse(data,
      () => {
        // Success callback
        const recipientElement = document.querySelector(`.recipient-item[data-id="${recipientId}"]`);
        if (recipientElement) {
          recipientElement.remove();
        } else {
          window.location.reload();
        }
      }
    );
  })
  .catch(error => {
    showToast(`Error: ${error.message}`, 'danger');
  });
}

// Function to delete a subscription plan
function deletePlan(planId) {
  fetch(`/admin/plans/${planId}`, {
    method: 'DELETE'
  })
  .then(response => response.json())
  .then(data => {
    handleApiResponse(data,
      () => {
        // Success callback
        const planElement = document.querySelector(`.plan-item[data-id="${planId}"]`);
        if (planElement) {
          planElement.remove();
        } else {
          window.location.reload();
        }
      }
    );
  })
  .catch(error => {
    showToast(`Error: ${error.message}`, 'danger');
  });
}

// Function to send a test webhook and extract variables
function sendTestWebhook(webhookId) {
  const statusSpan = document.getElementById('webhook-test-status');
  if (statusSpan) {
    statusSpan.textContent = 'Mengambil struktur variabel...';
    statusSpan.className = 'ml-2 text-sm text-blue-500';
  }

  // Fetch the structure of the last received webhook
  fetch(`/api/webhook/${webhookId}/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  })
  .then(response => response.json())
  .then(data => {
    if (data.success && data.variableStructure) {
      if (statusSpan) {
        statusSpan.textContent = `Variabel terdeteksi! Webhook terakhir diterima pada ${new Date(data.receivedAt).toLocaleString()}`;
        statusSpan.className = 'ml-2 text-sm text-green-500';
      }
      
      // Create draggable variables from the structure
      createDraggableVariables(data.variableStructure);
      
      showToast('Struktur variabel berhasil diambil!', 'success');
    } else {
      if (statusSpan) {
        statusSpan.textContent = data.toast?.text || 'Tidak ada data webhook tersedia.';
        statusSpan.className = 'ml-2 text-sm text-red-500';
      }
      
      showToast(data.toast?.text || 'Tidak ada data webhook tersedia. Silakan kirim webhook terlebih dahulu.', 'warning');
    }
  })
  .catch(error => {
    console.error('Error fetching webhook structure:', error);
    
    if (statusSpan) {
      statusSpan.textContent = 'Error mengambil struktur variabel.';
      statusSpan.className = 'ml-2 text-sm text-red-500';
    }
    
    showToast('Error mengambil struktur variabel', 'danger');
  });
}

// Function to create draggable variables from structure
function createDraggableVariables(variableStructure) {
  const variablesContainer = document.getElementById('variables-container');
  if (!variablesContainer) return;
  
  // Clear existing variables
  variablesContainer.innerHTML = '';
  
  // Add timestamp as a special variable if not already included
  const hasTimestamp = variableStructure.some(v => v.path === 'timestamp');
  if (!hasTimestamp) {
    variableStructure.push({
      path: 'timestamp',
      type: 'string'
    });
  }
  
  // Sort variables alphabetically
  variableStructure.sort((a, b) => a.path.localeCompare(b.path));
  
  // Create draggable elements for each variable
  variableStructure.forEach(variable => {
    const varElement = document.createElement('div');
    varElement.className = 'variable-item p-1 mb-1 bg-white border border-gray-300 rounded text-xs cursor-move flex justify-between items-center';
    varElement.draggable = true;
    varElement.dataset.variable = variable.path;
    
    // Get example value based on type
    let exampleValue;
    switch (variable.type) {
      case 'string':
        exampleValue = variable.path === 'timestamp' ? new Date().toLocaleString() : 'text';
        break;
      case 'number':
        exampleValue = '123';
        break;
      case 'boolean':
        exampleValue = 'true/false';
        break;
      case 'array':
        exampleValue = '[Array]';
        break;
      case 'object':
        exampleValue = '{Object}';
        break;
      default:
        exampleValue = '?';
    }
    
    // Create variable content with path and type
    varElement.innerHTML = `
      <span class="font-medium">{{{${variable.path}}}}</span>
      <span class="text-gray-500 ml-2 truncate" title="${variable.type}">${exampleValue}</span>
    `;
    
    // Add drag event listeners
    varElement.addEventListener('dragstart', handleDragStart);
    
    variablesContainer.appendChild(varElement);
  });
  
  // Show message if no variables found
  if (variableStructure.length === 0) {
    variablesContainer.innerHTML = '<div class="text-sm text-gray-500 italic">Tidak ada variabel yang terdeteksi dalam webhook.</div>';
  }
}

// Drag and drop functionality
function initDragAndDrop() {
  const templateTextarea = document.getElementById('custom_template');
  if (!templateTextarea) return;
  
  // Make the textarea a drop target
  templateTextarea.addEventListener('dragover', function(e) {
    e.preventDefault();
    this.classList.add('border-blue-500');
  });
  
  templateTextarea.addEventListener('dragleave', function() {
    this.classList.remove('border-blue-500');
  });
  
  templateTextarea.addEventListener('drop', function(e) {
    e.preventDefault();
    this.classList.remove('border-blue-500');
    
    const variable = e.dataTransfer.getData('text/plain');
    if (variable) {
      // Get cursor position or selection
      const start = this.selectionStart;
      const end = this.selectionEnd;
      
      // Insert the variable at cursor position
      const textBefore = this.value.substring(0, start);
      const textAfter = this.value.substring(end);
      
      this.value = textBefore + variable + textAfter;
      
      // Move cursor after the inserted variable
      this.selectionStart = start + variable.length;
      this.selectionEnd = start + variable.length;
      
      // Focus back on textarea
      this.focus();
    }
  });
}

// Handle drag start event
function handleDragStart(e) {
  const variable = `{{{${e.target.dataset.variable}}}}`;
  e.dataTransfer.setData('text/plain', variable);
  e.dataTransfer.effectAllowed = 'copy';
}

// Function to send a test webhook from the UI
function sendWebhookTest(webhookId) {
  const payloadTextarea = document.getElementById('test-webhook-payload');
  const statusSpan = document.getElementById('send-webhook-status');
  
  if (!payloadTextarea) return;
  
  let payload;
  try {
    payload = JSON.parse(payloadTextarea.value);
  } catch (error) {
    showToast('JSON tidak valid. Periksa kembali format JSON Anda.', 'danger');
    if (statusSpan) {
      statusSpan.textContent = 'JSON tidak valid';
      statusSpan.className = 'ml-3 text-sm text-red-500';
    }
    return;
  }
  
  if (statusSpan) {
    statusSpan.textContent = 'Mengirim webhook...';
    statusSpan.className = 'ml-3 text-sm text-blue-500';
  }
  
  // Send the webhook
  fetch(`/api/webhook/${webhookId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      if (statusSpan) {
        statusSpan.textContent = 'Webhook berhasil dikirim!';
        statusSpan.className = 'ml-3 text-sm text-green-500';
      }
      
      showToast('Webhook berhasil dikirim! Klik "Ambil Variabel dari Webhook Terakhir" untuk melihat variabel.', 'success');
    } else {
      if (statusSpan) {
        statusSpan.textContent = data.toast?.text || 'Gagal mengirim webhook';
        statusSpan.className = 'ml-3 text-sm text-red-500';
      }
      
      showToast(data.toast?.text || 'Gagal mengirim webhook', 'danger');
    }
  })
  .catch(error => {
    console.error('Error sending webhook:', error);
    
    if (statusSpan) {
      statusSpan.textContent = 'Error mengirim webhook';
      statusSpan.className = 'ml-3 text-sm text-red-500';
    }
    
    showToast('Error mengirim webhook', 'danger');
  });
}

// Function to insert text at cursor position
function insertTextAtCursor(text) {
  const textarea = document.getElementById('custom_template');
  if (!textarea) return;
  
  const cursorPos = textarea.selectionStart;
  const textBefore = textarea.value.substring(0, cursorPos);
  const textAfter = textarea.value.substring(cursorPos);
  
  textarea.value = textBefore + text + textAfter;
  textarea.selectionStart = cursorPos + text.length;
  textarea.selectionEnd = cursorPos + text.length;
  textarea.focus();
}

// Function to initialize emoji picker
function initEmojiPicker() {
  const emojiPickerBtn = document.getElementById('emoji-picker-btn');
  const emojiPickerModal = document.getElementById('emoji-picker-modal');
  const emojiSearch = document.getElementById('emoji-search');
  
  if (!emojiPickerBtn || !emojiPickerModal) return;
  
  // Open modal when emoji button is clicked
  emojiPickerBtn.addEventListener('click', function() {
    emojiPickerModal.classList.remove('hidden');
  });
  
  // Close modal when close button is clicked
  const closeButtons = emojiPickerModal.querySelectorAll('.emoji-modal-close');
  closeButtons.forEach(button => {
    button.addEventListener('click', function() {
      emojiPickerModal.classList.add('hidden');
    });
  });
  
  // Close modal when clicking outside of it
  emojiPickerModal.addEventListener('click', function(e) {
    if (e.target === emojiPickerModal) {
      emojiPickerModal.classList.add('hidden');
    }
  });
  
  // Close modal with Escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !emojiPickerModal.classList.contains('hidden')) {
      emojiPickerModal.classList.add('hidden');
    }
  });
  
  // Handle category switching
  const categoryButtons = document.querySelectorAll('.emoji-category-btn');
  categoryButtons.forEach(button => {
    button.addEventListener('click', function() {
      // Update active category button
      categoryButtons.forEach(btn => {
        btn.classList.remove('bg-blue-100', 'text-blue-800');
        btn.classList.add('bg-gray-100', 'text-gray-800');
      });
      this.classList.remove('bg-gray-100', 'text-gray-800');
      this.classList.add('bg-blue-100', 'text-blue-800');
      
      // Show the selected category grid and hide others
      const category = this.getAttribute('data-category');
      const emojiGrids = document.querySelectorAll('.emoji-grid');
      emojiGrids.forEach(grid => {
        grid.classList.add('hidden');
      });
      
      const selectedGrid = document.getElementById(`emoji-grid-${category}`);
      if (selectedGrid) {
        selectedGrid.classList.remove('hidden');
      }
    });
  });
  
  // Handle emoji search
  if (emojiSearch) {
    emojiSearch.addEventListener('input', function() {
      const searchTerm = this.value.toLowerCase();
      
      if (searchTerm.length === 0) {
        // If search is empty, reset to category view
        const activeCategory = document.querySelector('.emoji-category-btn.bg-blue-100');
        if (activeCategory) {
          const category = activeCategory.getAttribute('data-category');
          const emojiGrids = document.querySelectorAll('.emoji-grid');
          emojiGrids.forEach(grid => {
            grid.classList.add('hidden');
          });
          
          const selectedGrid = document.getElementById(`emoji-grid-${category}`);
          if (selectedGrid) {
            selectedGrid.classList.remove('hidden');
          }
        }
      } else {
        // Show all emoji grids for searching
        const emojiGrids = document.querySelectorAll('.emoji-grid');
        emojiGrids.forEach(grid => {
          grid.classList.remove('hidden');
        });
        
        // Filter emojis based on search
        const emojiButtons = document.querySelectorAll('.emoji-btn');
        emojiButtons.forEach(button => {
          const emoji = button.textContent;
          const emojiData = button.getAttribute('data-emoji');
          
          // Simple search - just check if emoji contains the search term
          if (emoji.toLowerCase().includes(searchTerm) || 
              (button.getAttribute('data-keywords') && 
               button.getAttribute('data-keywords').toLowerCase().includes(searchTerm))) {
            button.style.display = '';
          } else {
            button.style.display = 'none';
          }
        });
      }
    });
  }
}